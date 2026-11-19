import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { extractCommandNames } from './firmware-commands.js';

test('extracts the command names from the UHK firmware v18.0.3 reference manual', () => {
    // The bundled tag's manual is reproduced here with trailing whitespace trimmed.
    const manual = readFileSync(new URL('./fixtures/firmware-v18.0.3/reference-manual.md', import.meta.url), 'utf8');
    const names = extractCommandNames(manual);
    for (const command of ['notify', 'set', 'if', 'goTo', 'tapKey', 'overlayLayer', 'replaceLayer', 'autoRepeat', 'statsBattery']) {
        assert.ok(names.has(command), command);
    }
    for (const otherWord of ['<command>', '{', '&', 'KEYID', 'fn', 'noConsume', 'battery', 'writeExpr', 'ifNotRegEq']) {
        assert.ok(!names.has(otherWord), otherWord);
    }
});

test('treats an empty or partial command list as unavailable', () => {
    const core = ['notify', 'set', 'if', 'goTo'];
    for (const missing of core) {
        const available = core.filter(name => name !== missing).concat('tapKey');
        const manual = ['# GENERAL FUNCTIONALITY #', ...available.map(name => `COMMAND = ${name}`), '# DEPRECATED #'].join('\n');
        assert.equal(extractCommandNames(manual).size, 0, missing);
    }
    assert.equal(extractCommandNames('').size, 0);
});

test('includes deprecated commands and excludes removed commands', () => {
    const manual = [
        '# GENERAL FUNCTIONALITY #', 'COMMAND = notify', 'COMMAND = set', 'COMMAND = if', 'COMMAND = goTo',
        '# DEPRECATED #', 'COMMAND = OLD_COMMAND', 'OLD_COMMAND = deprecatedCommand', '# REMOVED #', 'COMMAND = removedCommand',
    ].join('\n');
    const names = extractCommandNames(manual);
    assert.ok(names.has('deprecatedCommand'));
    assert.ok(!names.has('removedCommand'));
});

test('treats an incompatible completion grammar as unavailable', () => {
    const manual = [
        '# GENERAL FUNCTIONALITY #', 'COMMAND = notify', 'COMMAND = set', 'COMMAND = if', 'COMMAND = goTo',
        'COMMAND = /[/', '# DEPRECATED #',
    ].join('\n');
    assert.equal(extractCommandNames(manual).size, 0);
});
