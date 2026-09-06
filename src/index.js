import inquirer from 'inquirer';
import autocomplete, { Separator as AutoSeparator } from 'inquirer-autocomplete-standalone';
import fs from 'fs';
import {
    ensureConfigFile,
    getConfig,
    saveConfig,
    SHELL,
    RC_FILE,
    RC_SHORT,
    getActiveProfile,
    applyToShell,
    resolveProvider,
    mergeProviders,
    checkProvider,
    doctorFindings,
    parseExport,
    pageSizeFor,
    notEmpty,
} from './lib.js';

ensureConfigFile();

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
  api check [name]            Health-check a provider (default: active one)
  api doctor                  Find hygiene issues and fix them interactively
  api help                    Show this help

Env:
  API_MANAGER_SHELL=zsh|bash|fish   Override shell detection
`);
}

function mustResolve(config, name) {
    try {
        return resolveProvider(config, name);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

function cmdUse(name) {
    if (!name) { console.error('Usage: api use <name>'); process.exit(1); }
    const config = getConfig();
    const key = mustResolve(config, name);
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

async function cmdCheck(name) {
    const config = getConfig();
    let key;
    if (name) {
        key = mustResolve(config, name);
    } else {
        key = getActiveProfile(config);
        if (key === 'None') { console.error('No active provider (pass a name or activate one first)'); process.exit(1); }
    }
    console.log(`Checking ${key} (${config[key].url}) ...`);
    const r = await checkProvider(config[key]);
    if (r.ok) {
        console.log(`✅ ${key}: ${r.method} — ${r.detail} (${r.ms}ms)`);
    } else {
        console.error(`❌ ${key}: unreachable (${r.ms}ms) — last error: ${r.detail}`);
        process.exit(1);
    }
}

function cmdExport() {
    // Pure JSON on stdout so `api export > backup.json` just works
    console.log(JSON.stringify(getConfig(), null, 4));
}

async function cmdDoctor() {
    let config = getConfig();
    const active = getActiveProfile(config);
    let rcToken = null;
    try {
        if (fs.existsSync(RC_FILE)) {
            rcToken = parseExport(fs.readFileSync(RC_FILE, 'utf-8'), 'ANTHROPIC_AUTH_TOKEN');
        }
    } catch { /* unreadable rc: skip mismatch check */ }

    const render = (findings) => {
        console.log(`🩺 Found ${findings.length} issue(s) (active: ${active}):\n`);
        findings.forEach((f, i) => console.log(`${i + 1}. ${f.title}\n   ${f.detail}`));
        console.log('');
    };

    let findings = doctorFindings(config, { rcToken });
    if (findings.length === 0) {
        console.log(`✅ All good: ${Object.keys(config).length} providers, no issues.`);
        return;
    }
    render(findings);

    if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1);

    // Fix 1: duplicates — keep first of each group, delete the rest
    const spare = doctorFindings(getConfig(), { rcToken })
        .filter(f => f.type === 'duplicates')
        .flatMap(f => f.providers.slice(1));
    if (spare.length > 0) {
        const { toDelete } = await inquirer.prompt([{
            type: 'checkbox', name: 'toDelete',
            message: `Delete ${spare.length} duplicate copie(s)? (keeps first of each group)`,
            choices: spare.map(s => ({ name: s, value: s, checked: true })),
            pageSize: pageSizeFor(spare.length), loop: false,
        }]);
        if (toDelete.length > 0) {
            config = getConfig();
            for (const k of toDelete) delete config[k];
            saveConfig(config);
            console.log(`🗑️  Deleted: ${toDelete.join(', ')}\n`);
        }
    }

    // Fix 2: fragile docker-bridge IP → localhost (port/path preserved)
    config = getConfig();
    const dockers = [...new Set(
        doctorFindings(config, { rcToken })
            .filter(f => f.type === 'docker-ip')
            .flatMap(f => f.providers)
    )];
    if (dockers.length > 0) {
        const { fixem } = await inquirer.prompt([{
            type: 'confirm', name: 'fixem',
            message: `Rewrite 172.17.0.2 → localhost in ${dockers.length} provider(s)?`,
            default: true,
        }]);
        if (fixem) {
            config = getConfig();
            for (const k of dockers) {
                if (config[k]) config[k].url = String(config[k].url).replace('172.17.0.2', 'localhost');
            }
            saveConfig(config);
            console.log(`🔧 Fixed: ${dockers.join(', ')}\n`);
        }
    }

    config = getConfig();
    findings = doctorFindings(config, { rcToken });
    if (findings.length === 0) {
        console.log(`✅ All fixed: ${Object.keys(config).length} providers, no issues.`);
    } else {
        render(findings);
        process.exit(1);
    }
}

async function cmdImport(file) {    let raw;
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
    let merged;
    try {
        merged = mergeProviders(getConfig(), data);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    saveConfig(merged.config);
    console.log(`Imported: ${merged.added} added, ${merged.updated} updated, ${merged.skipped} skipped.`);
}

async function dispatch(argv) {
    const [cmd, ...rest] = argv;
    switch ((cmd || '').toLowerCase()) {
        case 'use': cmdUse(rest[0]); break;
        case 'list': cmdList(); break;
        case 'current': cmdCurrent(); break;
        case 'export': cmdExport(); break;
        case 'import': await cmdImport(rest[0]); break;
        case 'check': await cmdCheck(rest[0]); break;
        case 'doctor': await cmdDoctor(); break;
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
