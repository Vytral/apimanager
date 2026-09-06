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

// --- Health-check -------------------------------------------------------------
// GET {base}/v1/models (Bearer, then x-api-key fallback), then a minimal
// POST {base}/v1/messages probe ("Say ok in one sentence").
// fetchFn is injectable so tests run offline. Never throws: always resolves
// { ok, ms, method, detail }.

export async function checkProvider({ token, url }, { fetchFn = fetch, timeoutMs = 8000, model } = {}) {
    const base = String(url).replace(/\/+$/, '');
    const timed = async (fn) => {
        const start = Date.now();
        try {
            return { ...(await fn()), ms: Date.now() - start };
        } catch (err) {
            return { ok: false, ms: Date.now() - start, detail: err && err.message ? err.message : String(err) };
        }
    };
    const getModels = (headers) => fetchFn(`${base}/v1/models`, {
        headers, signal: AbortSignal.timeout(timeoutMs),
    }).then(async (res) => {
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        let count = null;
        try {
            const body = await res.json();
            if (Array.isArray(body && body.data)) count = body.data.length;
        } catch { /* non-JSON body: still reachable */ }
        return { ok: true, detail: count == null ? 'reachable' : `${count} models` };
    });

    // 1) OpenAI-compatible bearer auth
    let r = await timed(() => getModels({ Authorization: `Bearer ${token}` }));
    if (r.ok) return { ...r, method: 'GET /v1/models (bearer)' };
    // 2) Anthropic-style key auth
    r = await timed(() => getModels({ 'x-api-key': token, 'anthropic-version': '2023-06-01' }));
    if (r.ok) return { ...r, method: 'GET /v1/models (x-api-key)' };
    // 3) Minimal chat probe
    const probeModel = model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
    r = await timed(() => fetchFn(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': token,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: probeModel,
            max_tokens: 16,
            messages: [{ role: 'user', content: 'Say "ok" in one sentence. Nothing else.' }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
    }).then(async (res) => {
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        let text = 'answered';
        try {
            const body = await res.json();
            const block = body && body.content && body.content.find && body.content.find(b => b.type === 'text');
            text = ((block && block.text) || 'answered').trim().split('\n')[0] || 'answered';
        } catch { /* keep default */ }
        return { ok: true, detail: `says: ${text}` };
    }));
    return { ...r, method: 'POST /v1/messages' };
}

// --- Doctor -------------------------------------------------------------------
// Offline hygiene checks over the provider store. Pure & testable.
// Returns [{ type, title, detail, providers }] — empty means all good.
export function doctorFindings(config, { rcToken = null } = {}) {
    const findings = [];
    const keys = Object.keys(config);

    // 1) exact duplicates (same token + url)
    const groups = new Map();
    for (const k of keys) {
        const e = config[k] || {};
        const sig = `${e.token || ''}\n${e.url || ''}`;
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(k);
    }
    for (const group of groups.values()) {
        if (group.length > 1) {
            findings.push({
                type: 'duplicates',
                title: `Duplicate providers: ${group.join(', ')}`,
                detail: 'Same token and URL. Keep one, delete the rest.',
                providers: group,
            });
        }
    }

    // 2) invalid entries (empty token/url)
    const invalid = keys.filter(k => {
        const e = config[k] || {};
        return typeof e.token !== 'string' || !e.token.trim() ||
            typeof e.url !== 'string' || !e.url.trim();
    });
    if (invalid.length > 0) {
        findings.push({
            type: 'invalid',
            title: `Invalid entries: ${invalid.join(', ')}`,
            detail: 'Missing token or URL. Fix with "api edit" or re-import.',
            providers: invalid,
        });
    }

    // 3) malformed urls
    const badUrl = keys.filter(k => {
        const u = (config[k] && config[k].url) || '';
        return u.trim() !== '' && !/^https?:\/\//i.test(u.trim());
    });
    if (badUrl.length > 0) {
        findings.push({
            type: 'bad-url',
            title: `URLs not starting with http(s): ${badUrl.join(', ')}`,
            detail: 'The BASE_URL should be a full http(s) URL.',
            providers: badUrl,
        });
    }

    // 4) fragile docker-bridge IP (changes on restart)
    const dockerIp = keys.filter(k => String((config[k] && config[k].url) || '').includes('172.17.0.2'));
    if (dockerIp.length > 0) {
        findings.push({
            type: 'docker-ip',
            title: `Fragile docker-bridge IP in: ${dockerIp.join(', ')}`,
            detail: '172.17.0.2 changes on restart — use http://localhost:PORT instead.',
            providers: dockerIp,
        });
    }

    // 5) shell points at credentials matching no stored provider
    if (rcToken && keys.length > 0 && !keys.some(k => config[k] && config[k].token === rcToken)) {
        findings.push({
            type: 'active-missing',
            title: 'Active shell credentials match no stored provider',
            detail: 'Your rc file has a token that is not in the store. Activate one with "api use <name>".',
            providers: [],
        });
    }

    return findings;
}

// --- UI helpers -------------------------------------------------------------

export function pageSizeFor(n, rows) {
    const r = rows ?? process.stdout.rows ?? 30;
    // fill almost the whole screen
    return Math.max(12, Math.min(n, r - 4, 30));
}

export const notEmpty = (input) => (input && input.trim() ? true : 'Cannot be empty');
