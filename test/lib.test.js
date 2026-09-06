import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    shellNameFromComm,
    detectShell,
    rcFileFor,
    zshQuote,
    fishQuote,
    unquoteSh,
    unquoteFish,
    parseExport,
    isAnthropicLine,
    getActiveProfile,
    applyToShell,
    resolveProvider,
    mergeProviders,
    pageSizeFor,
    notEmpty,
    getConfig,
    saveConfig,
} from '../src/lib.js';

const EVIL = 'test"; rm -rf /; echo "hi$HOME`bad`';

// sandbox HOME so tests never touch the real one
let sandbox;
beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apimanager-test-'));
});
const rc = (name = '.zshrc') => path.join(sandbox, name);

describe('shellNameFromComm', () => {
    const cases = [
        ['zsh', 'zsh'], ['-zsh', 'zsh'], ['/bin/zsh', 'zsh'], ['ZSH', 'zsh'],
        ['bash', 'bash'], ['-bash', 'bash'], ['/bin/bash', 'bash'],
        ['fish', 'fish'], ['/usr/bin/fish', 'fish'],
        ['opencode', null], ['node', null], ['', null], [null, null], [undefined, null],
    ];
    for (const [input, expected] of cases) {
        it(`${JSON.stringify(input)} -> ${expected}`, () => {
            const v = input && input.includes('/') ? path.basename(input) : input;
            assert.equal(shellNameFromComm(v), expected);
        });
    }
});

describe('detectShell', () => {
    it('honors API_MANAGER_SHELL override', () => {
        assert.equal(detectShell({ env: { API_MANAGER_SHELL: 'fish' }, readParent: () => 'zsh' }), 'fish');
        assert.equal(detectShell({ env: { API_MANAGER_SHELL: 'BASH' }, readParent: () => 'zsh' }), 'bash');
    });
    it('reads the parent process first', () => {
        assert.equal(detectShell({ env: {}, readParent: () => 'bash' }), 'bash');
        assert.equal(detectShell({ env: { SHELL: '/bin/zsh' }, readParent: () => 'fish' }), 'fish');
    });
    it('falls back to $SHELL then zsh', () => {
        assert.equal(detectShell({ env: { SHELL: '/bin/bash' }, readParent: () => { throw new Error('no ps'); } }), 'bash');
        assert.equal(detectShell({ env: {}, readParent: () => { throw new Error('no ps'); } }), 'zsh');
    });
});

describe('rcFileFor', () => {
    it('maps shells to rc files', () => {
        assert.equal(rcFileFor('zsh', sandbox), path.join(sandbox, '.zshrc'));
        assert.equal(rcFileFor('bash', sandbox), path.join(sandbox, '.bashrc'));
        assert.equal(rcFileFor('fish', sandbox), path.join(sandbox, '.config/fish/config.fish'));
        assert.equal(rcFileFor('weird', sandbox), path.join(sandbox, '.zshrc'));
    });
});

describe('quoting roundtrips', () => {
    it('zshQuote survives ", $, backticks', () => {
        assert.equal(unquoteSh(zshQuote(EVIL)), EVIL);
    });
    it('zshQuote survives single quotes', () => {
        assert.equal(unquoteSh(zshQuote("abc'def")), "abc'def");
    });
    it('fishQuote survives evil + quotes + backslashes', () => {
        assert.equal(unquoteFish(fishQuote(EVIL)), EVIL);
        assert.equal(unquoteFish(fishQuote("a'b\\c")), "a'b\\c");
    });
});

describe('parseExport', () => {
    it('reads sh-style double and single quotes', () => {
        assert.equal(parseExport('export ANTHROPIC_AUTH_TOKEN="sk-abc"', 'ANTHROPIC_AUTH_TOKEN'), 'sk-abc');
        assert.equal(parseExport("export ANTHROPIC_AUTH_TOKEN='sk-abc'", 'ANTHROPIC_AUTH_TOKEN'), 'sk-abc');
    });
    it('tolerates leading whitespace', () => {
        assert.equal(parseExport('  export ANTHROPIC_BASE_URL="https://x.com"', 'ANTHROPIC_BASE_URL'), 'https://x.com');
    });
    it('reads fish-style set lines', () => {
        assert.equal(parseExport('set -gx ANTHROPIC_AUTH_TOKEN tok-1', 'ANTHROPIC_AUTH_TOKEN'), 'tok-1');
        assert.equal(parseExport("set -Ux ANTHROPIC_BASE_URL 'https://x.com'", 'ANTHROPIC_BASE_URL'), 'https://x.com');
    });
    it('returns null when absent', () => {
        assert.equal(parseExport('export PATH="/x"', 'ANTHROPIC_AUTH_TOKEN'), null);
    });
});

describe('isAnthropicLine', () => {
    it('matches our vars, ignores everything else', () => {
        assert.equal(isAnthropicLine('export ANTHROPIC_AUTH_TOKEN=\'x\'', 'ANTHROPIC_AUTH_TOKEN'), true);
        assert.equal(isAnthropicLine('set -gx ANTHROPIC_BASE_URL https://x', 'ANTHROPIC_BASE_URL'), true);
        assert.equal(isAnthropicLine('set -Ux ANTHROPIC_AUTH_TOKEN x', 'ANTHROPIC_AUTH_TOKEN'), true);
        assert.equal(isAnthropicLine('export PATH="/x"', 'ANTHROPIC_AUTH_TOKEN'), false);
        assert.equal(isAnthropicLine('set -gx PATH /x', 'ANTHROPIC_AUTH_TOKEN'), false);
        assert.equal(isAnthropicLine('export ANTHROPIC_AUTH_TOKEN2=x', 'ANTHROPIC_AUTH_TOKEN'), false);
    });
});

describe('applyToShell + getActiveProfile', () => {
    for (const shell of ['zsh', 'bash', 'fish']) {
        it(`roundtrips on ${shell} (preserves other lines, replaces stale)`, () => {
            const file = path.join(sandbox, shell === 'fish' ? 'config.fish' : `.${shell}rc`);
            fs.writeFileSync(file, 'export PATH="/x"\n' + (shell === 'fish'
                ? 'set -gx ANTHROPIC_AUTH_TOKEN old\n'
                : 'export ANTHROPIC_AUTH_TOKEN="old"\n'));
            const config = { p1: { token: EVIL, url: 'https://one.example' } };
            applyToShell(EVIL, 'https://one.example', { shell, rcFile: file });
            const out = fs.readFileSync(file, 'utf-8');
            assert.match(out, /export PATH="\/x"/);
            assert.ok(!out.includes('old'), 'stale value removed');
            assert.equal(getActiveProfile(config, file), 'p1');
        });
    }
    it('disambiguates providers sharing a token via url', () => {
        const file = rc();
        const config = {
            a: { token: 'same', url: 'https://a.example' },
            b: { token: 'same', url: 'https://b.example' },
        };
        applyToShell('same', 'https://b.example', { shell: 'zsh', rcFile: file });
        assert.equal(getActiveProfile(config, file), 'b');
    });
    it('returns None when nothing is set', () => {
        assert.equal(getActiveProfile({ p1: { token: 'x', url: 'y' } }, rc('missing')), 'None');
    });
});

describe('resolveProvider', () => {
    const config = { Freemodel: { token: 'a', url: 'u' }, Tabi: { token: 'b', url: 'v' } };
    it('exact match wins', () => assert.equal(resolveProvider(config, 'Freemodel'), 'Freemodel'));
    it('unique case-insensitive match works', () => assert.equal(resolveProvider(config, 'tabi'), 'Tabi'));
    it('unknown throws', () => assert.throws(() => resolveProvider(config, 'nope'), /Unknown provider/));
    it('ambiguous throws', () => {
        assert.throws(() => resolveProvider({ Ab: { token: '1', url: 'u' }, aB: { token: '2', url: 'v' } }, 'ab'), /Ambiguous/);
    });
});

describe('mergeProviders', () => {
    it('adds, updates, skips invalid', () => {
        const { config, added, updated, skipped } = mergeProviders(
            { old: { token: 't', url: 'u' } },
            {
                fresh: { token: ' n ', url: ' https://n.example ' },
                old: { token: 't2', url: 'u2' },
                bad: { token: '', url: 'x' },
                worse: 'nope',
            }
        );
        assert.equal(added, 1);
        assert.equal(updated, 1);
        assert.equal(skipped, 2);
        assert.deepEqual(config.fresh, { token: 'n', url: 'https://n.example' });
        assert.deepEqual(config.old, { token: 't2', url: 'u2' });
    });
    it('rejects non-objects', () => {
        assert.throws(() => mergeProviders({}, [1, 2]), /Invalid format/);
        assert.throws(() => mergeProviders({}, null), /Invalid format/);
    });
});

describe('config store', () => {
    it('roundtrips JSON', () => {
        const file = path.join(sandbox, 'api-manager.json');
        saveConfig({ a: { token: 't', url: 'u' } }, file);
        assert.deepEqual(getConfig(file), { a: { token: 't', url: 'u' } });
    });
    it('corrupt JSON reads as empty', () => {
        const file = path.join(sandbox, 'api-manager.json');
        fs.writeFileSync(file, 'not json{{{');
        assert.deepEqual(getConfig(file), {});
    });
});

describe('misc', () => {
    it('pageSizeFor clamps to screen', () => {
        assert.equal(pageSizeFor(100, 30), 26);
        assert.equal(pageSizeFor(5, 30), 12);
        assert.equal(pageSizeFor(20, 30), 20);
    });
    it('notEmpty validates', () => {
        assert.equal(notEmpty(' x '), true);
        assert.equal(notEmpty('   '), 'Cannot be empty');
    });
});
