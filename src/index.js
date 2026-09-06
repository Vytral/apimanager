import inquirer from 'inquirer';
import autocomplete, { Separator as AutoSeparator } from 'inquirer-autocomplete-standalone';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_FILE = path.join(os.homedir(), '.config/api-manager.json');

// --- Shell detection --------------------------------------------------------
// Figures out which shell launched us so env vars land in the right rc file.
// Override with API_MANAGER_SHELL=zsh|bash|fish. Falls back to $SHELL, then zsh.
function shellNameFromComm(comm) {
    const c = (comm || '').toLowerCase().replace(/^-/, '');
    if (c.includes('zsh')) return 'zsh';
    if (c.includes('bash')) return 'bash';
    if (c.includes('fish')) return 'fish';
    return null;
}

function detectShell() {
    const forced = (process.env.API_MANAGER_SHELL || '').trim().toLowerCase();
    if (forced === 'zsh' || forced === 'bash' || forced === 'fish') return forced;
    try {
        const parent = execSync(`ps -p ${process.ppid} -o comm=`, {
            encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        const fromParent = shellNameFromComm(path.basename(parent));
        if (fromParent) return fromParent;
    } catch { /* fall through to $SHELL */ }
    return shellNameFromComm(path.basename(process.env.SHELL || '')) || 'zsh';
}

function rcFileFor(shell) {
    if (shell === 'bash') return path.join(os.homedir(), '.bashrc');
    if (shell === 'fish') return path.join(os.homedir(), '.config/fish/config.fish');
    return path.join(os.homedir(), '.zshrc');
}

const SHELL = detectShell();
const RC_FILE = rcFileFor(SHELL);
const RC_SHORT = `~/${path.relative(os.homedir(), RC_FILE)}`;

// Ensure the JSON store exists
if (!fs.existsSync(path.dirname(CONFIG_FILE))) fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, '{}');

const getConfig = () => {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
        return {};
    }
};
const saveConfig = (data) => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 4));
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort */ }
};

// Safe quoting for sh-style shells: single-quote, escaping ' as '\''
// Prevents injection via ", $, `, \, !, etc.
function zshQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Safe quoting for fish: inside single quotes, escape \ and ' with backslash
function fishQuote(s) {
    return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function unquoteSh(v) {
    v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
        // un-escape the '\'' sequence produced by zshQuote
        if (v.includes("'\\''")) v = v.split("'\\''").join("'");
    }
    return v;
}

function unquoteFish(v) {
    v = v.trim();
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
        return v.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
        return v.slice(1, -1);
    }
    return v;
}

// Reads a value whether the rc file uses sh-style (export X=...)
// or fish-style (set -gx/-Ux X ...) syntax
function parseExport(content, name) {
    const sh = content.match(new RegExp(`^\\s*export\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (sh) return unquoteSh(sh[1]);
    const fish = content.match(new RegExp(`^\\s*set\\s+(?:-\\w+\\s+)*${name}\\s+(.+?)\\s*$`, 'm'));
    if (fish) return unquoteFish(fish[1]);
    return null;
}

// Detects the active profile by reading the current shell's rc file
// (token+url, to disambiguate)
function getActiveProfile(config) {
    if (!fs.existsSync(RC_FILE)) return 'None';
    const content = fs.readFileSync(RC_FILE, 'utf-8');
    const currentToken = parseExport(content, 'ANTHROPIC_AUTH_TOKEN');
    const currentUrl = parseExport(content, 'ANTHROPIC_BASE_URL');
    if (!currentToken) return 'None';
    return Object.keys(config).find(k =>
        config[k].token === currentToken &&
        (currentUrl == null || config[k].url === currentUrl)
    ) || 'None';
}

function isAnthropicLine(t, name) {
    // sh-style: export NAME=... | fish-style: set ... NAME ...
    if (t.startsWith(`export ${name}=`) || t.startsWith(`export ${name} =`)) return true;
    return t.startsWith('set ') && new RegExp(`^set\\s+(?:-\\w+\\s+)*${name}(\\s|$)`).test(t);
}

function applyToShell(token, url) {
    if (!fs.existsSync(path.dirname(RC_FILE))) fs.mkdirSync(path.dirname(RC_FILE), { recursive: true });
    let content = fs.existsSync(RC_FILE) ? fs.readFileSync(RC_FILE, 'utf-8') : '';
    // Filter out old lines (robust to leading whitespace)
    content = content.split('\n')
        .filter(line => {
            const t = line.trimStart();
            return !isAnthropicLine(t, 'ANTHROPIC_AUTH_TOKEN') && !isAnthropicLine(t, 'ANTHROPIC_BASE_URL');
        })
        .join('\n');

    // Append new values with safe quoting for the detected shell.
    // Note: fish uses `set -gx` in config.fish (a child process cannot set
    // the parent's universal `set -Ux` vars, this is the equivalent).
    if (SHELL === 'fish') {
        content += `\nset -gx ANTHROPIC_AUTH_TOKEN ${fishQuote(token)}\nset -gx ANTHROPIC_BASE_URL ${fishQuote(url)}\n`;
    } else {
        content += `\nexport ANTHROPIC_AUTH_TOKEN=${zshQuote(token)}\nexport ANTHROPIC_BASE_URL=${zshQuote(url)}\n`;
    }
    fs.writeFileSync(RC_FILE, content.trim() + '\n');
    try { fs.chmodSync(RC_FILE, 0o600); } catch { /* best effort */ }
}

function pageSizeFor(n) {
    const rows = process.stdout.rows || 30;
    // fill almost the whole screen
    return Math.max(12, Math.min(n, rows - 4, 30));
}

const notEmpty = (input) => (input && input.trim() ? true : 'Cannot be empty');

async function manageProviders() {
    const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: '⚙️  PROVIDER MANAGEMENT',
        pageSize: 10,
        loop: false,
        choices: [
            { name: '➕ Add new provider', value: 'add' },
            { name: '📝 Edit provider', value: 'edit' },
            { name: '❌ Delete provider(s)', value: 'delete' },
            new inquirer.Separator(),
            { name: '↩️  Back', value: 'back' }
        ]
    }]);

    let config = getConfig();

    if (action === 'back') return null;

    if (action === 'add' || action === 'edit') {
        let name = '';
        if (action === 'edit') {
            const choices = Object.keys(config);
            if (choices.length === 0) { console.log('⚠️ No providers to edit.'); return null; }
            const res = await inquirer.prompt([{
                type: 'list', name: 'name', message: 'Select provider to edit:',
                choices, pageSize: pageSizeFor(choices.length), loop: false
            }]);
            name = res.name;
        } else {
            const res = await inquirer.prompt([{
                type: 'input', name: 'name',
                message: 'Provider name (e.g. OpenRouter):',
                validate: notEmpty
            }]);
            name = res.name.trim();
        }

        if (!name) return null;
        const current = config[name] || { token: '', url: '' };

        // URL first, then KEY (more comfortable)
        const data = await inquirer.prompt([
            { type: 'input', name: 'url', message: 'BASE URL:', default: current.url, validate: notEmpty },
            { type: 'input', name: 'token', message: 'AUTH TOKEN:', default: current.token, validate: notEmpty }
        ]);

        config[name] = { url: data.url.trim(), token: data.token.trim() };
        saveConfig(config);

        // Auto-activate the new/edited entry: no need to go find it in the list
        applyToShell(config[name].token, config[name].url);
        console.log(`\n✅ Provider "${name}" saved and activated.`);
        return name;
    }

    if (action === 'delete') {
        const choices = Object.keys(config);
        if (choices.length === 0) { console.log('⚠️ No providers to delete.'); return null; }
        const { toDelete } = await inquirer.prompt([{
            type: 'checkbox',
            name: 'toDelete',
            message: 'Select what to delete (space to mark, enter to confirm):',
            choices,
            pageSize: pageSizeFor(choices.length),
            loop: false,
            validate: (sel) => (sel.length > 0 ? true : 'Mark at least one or go back')
        }]);
        if (!toDelete || toDelete.length === 0) return null;
        for (const k of toDelete) delete config[k];
        saveConfig(config);
        console.log(`🗑️  Deleted: ${toDelete.join(', ')}`);
        return null;
    }

    return null;
}

async function main() {
    while (true) {
        console.clear();
        console.log('Select provider');
        console.log('Switch between Anthropic/Claude API environments. Your pick updates your shell config instantly.\n');

        const config = getConfig();
        const active = getActiveProfile(config);
        const keys = Object.keys(config);

        if (keys.length === 0) {
            console.log('No providers. Add the first one:');
            await manageProviders();
            continue;
        }

        console.log(`Active: ${active} (${keys.length} providers · ${SHELL} → ${RC_SHORT})\n`);

        // Web-style search: list always visible, narrows as you type.
        // Empty input: Manage/Exit on top. Typing: best matches first so the
        // top (highlighted) choice is the closest match, Manage/Exit move down
        // but never disappear.
        const selected = await autocomplete({
            message: 'Select provider:',
            pageSize: pageSizeFor(keys.length + 3),
            emptyText: 'No matches... (clear to show all)',
            source: async (input) => {
                const f = (input || '').trim().toLowerCase();
                const manage = [
                    { name: '⚙️  Manage Providers (Add/Edit/Delete)', value: 'MANAGE' },
                    { name: '❌ Cancel & Exit', value: 'EXIT' }
                ];
                if (!f) {
                    return [
                        ...manage,
                        new AutoSeparator(`── ${keys.length}/${keys.length} providers ──`),
                        ...keys.map(key => {
                            const isCurrent = key === active;
                            const prefix = isCurrent ? '✔ ' : '  ';
                            return {
                                name: `${prefix}${key.padEnd(18)} ${config[key].url}`,
                                value: key,
                            };
                        })
                    ];
                }
                const scored = keys.map(k => {
                    const kl = k.toLowerCase();
                    const ul = (config[k].url || '').toLowerCase();
                    const score = kl.startsWith(f) ? 0 : kl.includes(f) ? 1 : ul.includes(f) ? 2 : 3;
                    return { k, score };
                }).filter(x => x.score < 3)
                    .sort((a, b) => a.score - b.score || a.k.localeCompare(b.k))
                    .map(x => x.k);
                return [
                    ...scored.map(key => {
                        const isCurrent = key === active;
                        const prefix = isCurrent ? '✔ ' : '  ';
                        return {
                            name: `${prefix}${key.padEnd(18)} ${config[key].url}`,
                            value: key,
                        };
                    }),
                    new AutoSeparator(`── ${scored.length}/${keys.length} providers ──`),
                    ...manage
                ];
            }
        });

        if (selected === 'EXIT') process.exit(0);
        if (selected === 'MANAGE') {
            const justAdded = await manageProviders();
            // manageProviders already auto-activates on add/edit, so exit
            if (justAdded) break;
            continue;
        }
        const target = config[selected];
        if (!target) continue;
        applyToShell(target.token, target.url);
        console.log(`\n🚀 Active profile set to: ${selected} (${RC_SHORT} updated)`);
        break;
    }
}

// --- Non-interactive CLI (scripting & aliases) -------------------------------

function printHelp() {
    console.log(`API Manager — switch Claude/Anthropic providers from the terminal

Usage:
  api                         Open the interactive picker
  api use <name>              Activate a provider (exact, or unique case-insensitive match)
  api list                    List providers (* marks the active one)
  api current                 Print the active provider name
  api export                  Print providers JSON to stdout (api export > backup.json)
  api import [file]           Merge providers from a JSON file (or stdin pipe)
  api help                    Show this help

Env:
  API_MANAGER_SHELL=zsh|bash|fish   Override shell detection
`);
}

function resolveProvider(config, name) {
    const keys = Object.keys(config);
    if (config[name]) return name;
    const ci = keys.filter(k => k.toLowerCase() === String(name).toLowerCase());
    if (ci.length === 1) return ci[0];
    if (ci.length > 1) {
        console.error(`Ambiguous name "${name}", matches: ${ci.join(', ')}`);
        process.exit(1);
    }
    console.error(`Unknown provider "${name}". Run "api list" to see available ones.`);
    process.exit(1);
}

function cmdUse(name) {
    if (!name) { console.error('Usage: api use <name>'); process.exit(1); }
    const config = getConfig();
    const key = resolveProvider(config, name);
    applyToShell(config[key].token, config[key].url);
    console.log(`Active profile set to: ${key} (${RC_SHORT} updated)`);
}

function cmdList() {
    const config = getConfig();
    const active = getActiveProfile(config);
    for (const key of Object.keys(config)) {
        console.log(`${key === active ? '*' : ' '} ${key} ${config[key].url}`);
    }
}

function cmdCurrent() {
    const active = getActiveProfile(getConfig());
    if (active === 'None') { console.error('No active provider'); process.exit(1); }
    console.log(active);
}

function cmdExport() {
    // Pure JSON on stdout so `api export > backup.json` just works
    console.log(JSON.stringify(getConfig(), null, 4));
}

async function cmdImport(file) {
    let raw;
    if (file) {
        if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(1); }
        raw = fs.readFileSync(file, 'utf-8');
    } else if (!process.stdin.isTTY) {
        raw = fs.readFileSync(0, 'utf-8');
    } else {
        console.error('Usage: api import <file>  (or pipe JSON via stdin)');
        process.exit(1);
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        console.error('Invalid JSON');
        process.exit(1);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        console.error('Invalid format: expected { "name": { "token": "...", "url": "..." } }');
        process.exit(1);
    }
    const config = getConfig();
    let added = 0, updated = 0, skipped = 0;
    for (const [name, entry] of Object.entries(data)) {
        const token = entry && typeof entry.token === 'string' ? entry.token.trim() : '';
        const url = entry && typeof entry.url === 'string' ? entry.url.trim() : '';
        if (!name || !token || !url) { skipped++; continue; }
        if (config[name]) updated++; else added++;
        config[name] = { token, url };
    }
    saveConfig(config);
    console.log(`Imported: ${added} added, ${updated} updated, ${skipped} skipped.`);
}

async function dispatch(argv) {
    const [cmd, ...rest] = argv;
    switch ((cmd || '').toLowerCase()) {
        case 'use': cmdUse(rest[0]); break;
        case 'list': cmdList(); break;
        case 'current': cmdCurrent(); break;
        case 'export': cmdExport(); break;
        case 'import': await cmdImport(rest[0]); break;
        case 'help': case '--help': case '-h': printHelp(); break;
        default:
            console.error(`Unknown command "${cmd}". Run "api help".`);
            process.exit(1);
    }
}

const CLI_ARGS = process.argv.slice(2);
if (CLI_ARGS.length > 0) {
    dispatch(CLI_ARGS).catch(err => { console.error(err); process.exit(1); });
} else {
    main().catch(console.error);
}
