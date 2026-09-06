// API Manager — pure logic (no interactive prompts here).
// Everything in this module is import-safe and unit-testable:
// shell functions take explicit args, file functions take explicit paths.
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Paths ------------------------------------------------------------------

export function homeDir() {
    return os.homedir();
}

export function defaultConfigFile(home = homeDir()) {
    return path.join(home, '.config/api-manager.json');
}

export function ensureConfigFile(file = defaultConfigFile()) {
    if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, '{}');
        try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    }
    return file;
}

export function getConfig(file = defaultConfigFile()) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return {};
    }
}

export function saveConfig(data, file = defaultConfigFile()) {
    fs.writeFileSync(file, JSON.stringify(data, null, 4));
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

// --- Shell detection --------------------------------------------------------
// Figures out which shell launched us so env vars land in the right rc file.
// Override with API_MANAGER_SHELL=zsh|bash|fish. Falls back to $SHELL, then zsh.

export function shellNameFromComm(comm) {
    const c = (comm || '').toLowerCase().replace(/^-/, '');
    if (c.includes('zsh')) return 'zsh';
    if (c.includes('bash')) return 'bash';
    if (c.includes('fish')) return 'fish';
    return null;
}

function defaultReadParent(ppid) {
    return execSync(`ps -p ${ppid} -o comm=`, {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
}

export function detectShell({ env = process.env, ppid = process.ppid, readParent = defaultReadParent } = {}) {
    const forced = (env.API_MANAGER_SHELL || '').trim().toLowerCase();
    if (forced === 'zsh' || forced === 'bash' || forced === 'fish') return forced;
    try {
        const fromParent = shellNameFromComm(path.basename(readParent(ppid)));
        if (fromParent) return fromParent;
    } catch { /* fall through to $SHELL */ }
    return shellNameFromComm(path.basename(env.SHELL || '')) || 'zsh';
}

export function rcFileFor(shell, home = homeDir()) {
    if (shell === 'bash') return path.join(home, '.bashrc');
    if (shell === 'fish') return path.join(home, '.config/fish/config.fish');
    return path.join(home, '.zshrc');
}

// Runtime constants for the real process (computed once at import).
export const SHELL = detectShell();
export const RC_FILE = rcFileFor(SHELL);
export const RC_SHORT = `~/${path.relative(homeDir(), RC_FILE)}`;

// --- Quoting (injection-safe writes) ----------------------------------------

// sh-style shells: single-quote, escaping ' as '\''
export function zshQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// fish: inside single quotes, escape \ and ' with backslash
export function fishQuote(s) {
    return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

export function unquoteSh(v) {
    v = String(v).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        v = v.slice(1, -1);
        // un-escape the '\'' sequence produced by zshQuote
        if (v.includes("'\\''")) v = v.split("'\\''").join("'");
    }
    return v;
}

export function unquoteFish(v) {
    v = String(v).trim();
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
        return v.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
        return v.slice(1, -1);
    }
    return v;
}

// Reads a value whether the rc file uses sh-style (export X=...)
// or fish-style (set -gx/-Ux X ...) syntax. Returns null when absent.
export function parseExport(content, name) {
    const sh = String(content).match(new RegExp(`^\\s*export\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (sh) return unquoteSh(sh[1]);
    const fish = String(content).match(new RegExp(`^\\s*set\\s+(?:-\\w+\\s+)*${name}\\s+(.+?)\\s*$`, 'm'));
    if (fish) return unquoteFish(fish[1]);
    return null;
}

// True when a trimmed rc line sets one of our ANTHROPIC_* vars
// (sh-style export or fish-style set). Used to filter stale lines.
export function isAnthropicLine(trimmedLine, name) {
    const t = trimmedLine;
    if (t.startsWith(`export ${name}=`) || t.startsWith(`export ${name} =`)) return true;
    return t.startsWith('set ') && new RegExp(`^set\\s+(?:-\\w+\\s+)*${name}(\\s|$)`).test(t);
}

// --- Profiles ---------------------------------------------------------------

// Detects the active profile by reading the shell's rc file
// (token+url, to disambiguate providers sharing a token).
export function getActiveProfile(config, rcFile = RC_FILE) {
    if (!fs.existsSync(rcFile)) return 'None';
    const content = fs.readFileSync(rcFile, 'utf-8');
    const currentToken = parseExport(content, 'ANTHROPIC_AUTH_TOKEN');
    const currentUrl = parseExport(content, 'ANTHROPIC_BASE_URL');
    if (!currentToken) return 'None';
    return Object.keys(config).find(k =>
        config[k].token === currentToken &&
        (currentUrl == null || config[k].url === currentUrl)
    ) || 'None';
}

export function applyToShell(token, url, { shell = SHELL, rcFile = RC_FILE } = {}) {
    if (!fs.existsSync(path.dirname(rcFile))) fs.mkdirSync(path.dirname(rcFile), { recursive: true });
    let content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf-8') : '';
    content = content.split('\n')
        .filter(line => {
            const t = line.trimStart();
            return !isAnthropicLine(t, 'ANTHROPIC_AUTH_TOKEN') && !isAnthropicLine(t, 'ANTHROPIC_BASE_URL');
        })
        .join('\n');

    // Note: fish uses `set -gx` in config.fish (a child process cannot set
    // the parent's universal `set -Ux` vars — this is the equivalent).
    if (shell === 'fish') {
        content += `\nset -gx ANTHROPIC_AUTH_TOKEN ${fishQuote(token)}\nset -gx ANTHROPIC_BASE_URL ${fishQuote(url)}\n`;
    } else {
        content += `\nexport ANTHROPIC_AUTH_TOKEN=${zshQuote(token)}\nexport ANTHROPIC_BASE_URL=${zshQuote(url)}\n`;
    }
    fs.writeFileSync(rcFile, content.trim() + '\n');
    try { fs.chmodSync(rcFile, 0o600); } catch { /* best effort */ }
}

// Exact match first, then unique case-insensitive. Throws on miss/ambiguity.
export function resolveProvider(config, name) {
    const keys = Object.keys(config);
    if (Object.hasOwn(config, name)) return name;
    const ci = keys.filter(k => k.toLowerCase() === String(name).toLowerCase());
    if (ci.length === 1) return ci[0];
    if (ci.length > 1) throw new Error(`Ambiguous name "${name}", matches: ${ci.join(', ')}`);
    throw new Error(`Unknown provider "${name}". Run "api list" to see available ones.`);
}

// Pure merge for `api import`: {name: {token, url}} into config.
// Trims values, skips entries with empty name/token/url.
export function mergeProviders(config, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid format: expected { "name": { "token": "...", "url": "..." } }');
    }
    const next = { ...config };
    let added = 0, updated = 0, skipped = 0;
    for (const [name, entry] of Object.entries(data)) {
        const token = entry && typeof entry.token === 'string' ? entry.token.trim() : '';
        const url = entry && typeof entry.url === 'string' ? entry.url.trim() : '';
        if (!name || !token || !url) { skipped++; continue; }
        if (Object.hasOwn(next, name)) updated++; else added++;
        next[name] = { token, url };
    }
    return { config: next, added, updated, skipped };
}

// --- UI helpers -------------------------------------------------------------

export function pageSizeFor(n, rows) {
    const r = rows ?? process.stdout.rows ?? 30;
    // fill almost the whole screen
    return Math.max(12, Math.min(n, r - 4, 30));
}

export const notEmpty = (input) => (input && input.trim() ? true : 'Cannot be empty');
