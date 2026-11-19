import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pruneAiTags, type UserConfigurationJson } from './config-diff.js';

const keyId = 'key:QWR/base/0/0';
const keymapId = 'keymap:QWR';
const macroId = 'macro:Example';

function configuration(scancode = 4): UserConfigurationJson {
    return {
        keymaps: [{
            abbreviation: 'QWR',
            name: 'QWERTY',
            isDefault: true,
            layers: [{ id: 'base', modules: [{ id: 0, keyActions: [{ keyActionType: 'keystroke', scancode }] }] }],
        }],
        macros: [],
    };
}

test('reverting a key drops its AI tag before a later hand edit', () => {
    const baseline = configuration();
    const tags = pruneAiTags([keyId], baseline, configuration());
    assert.deepEqual(tags, []);
    assert.deepEqual(pruneAiTags(tags, baseline, configuration(6)), []);
});

test('changing an AI-tagged key to another value keeps its tag while reverted macros lose theirs', () => {
    const baseline = configuration();
    assert.deepEqual(pruneAiTags([keyId, macroId], baseline, configuration(5)), [keyId]);
    const tags = [keyId];
    assert.equal(pruneAiTags(tags, baseline, configuration(5)), tags);
});

test('re-adding a removed keymap as it is on the keyboard drops the keymap tag', () => {
    const baseline = configuration();
    const removed = { ...baseline, keymaps: [] };
    const tags = pruneAiTags([keymapId], baseline, removed);
    assert.deepEqual(tags, [keymapId]);
    assert.deepEqual(pruneAiTags(tags, baseline, configuration()), []);
});

test('an unknown keyboard baseline preserves all AI tags', () => {
    const tags = [keyId, keymapId, macroId];
    assert.equal(pruneAiTags(tags, undefined, configuration()), tags);
});

test('pruning an empty tag set skips the configuration diff', () => {
    const tags: string[] = [];
    const current = {
        ...configuration(),
        get keymaps(): UserConfigurationJson['keymaps'] {
            assert.fail('the diff should not read the configuration');
        },
    };
    assert.equal(pruneAiTags(tags, configuration(), current), tags);
});
