import assert from 'node:assert/strict';
import { test } from 'node:test';
import { require as loadTs } from 'tsx/cjs/api';
import { UHK_80_USER_CONFIG, UserConfiguration } from 'uhk-common';

// Initialize the renderer globals before loading the effects and their store selectors.
Object.assign(globalThis, { window: { getUhkTheme: () => 'light' } });
const { followKeymapAfterAiWrite }: typeof import('../../../../test/keymap-effects.js') =
    loadTs('../../../../test/keymap-effects.ts', import.meta.url);

const config = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));

test('an AI write that removes the keymap on screen moves to the keymap Agent now selects', async () => {
    const renamed = config.clone();
    renamed.keymaps.find(keymap => keymap.abbreviation === 'COL').abbreviation = 'CPC';
    const navigate = await followKeymapAfterAiWrite({ shown: 'COL', userConfiguration: renamed, selectedKeymapAbbr: 'CPC' });
    assert.deepEqual(navigate.mock.calls.map(call => call.arguments), [[['/keymap', 'CPC'], { queryParamsHandling: 'merge' }]]);

    const deleted = config.clone();
    deleted.keymaps = deleted.keymaps.filter(keymap => keymap.abbreviation !== 'COL');
    const fallback = await followKeymapAfterAiWrite({ shown: 'COL', userConfiguration: deleted, selectedKeymapAbbr: undefined });
    assert.deepEqual(fallback.mock.calls.map(call => call.arguments), [[['/keymap', 'QWR'], { queryParamsHandling: 'merge' }]]);
});

test('an AI write leaves the screen alone while its keymap still exists or no keymap is shown', async () => {
    for (const shown of ['COL', undefined]) {
        const navigate = await followKeymapAfterAiWrite({ shown, userConfiguration: config, selectedKeymapAbbr: 'COL' });
        assert.equal(navigate.mock.callCount(), 0, String(shown));
    }
    // The route carries the abbreviation URL-encoded, as the keymap screen reads it.
    const symbols = config.clone();
    symbols.keymaps.find(keymap => keymap.abbreviation === 'COL').abbreviation = 'C$ ';
    const encoded = await followKeymapAfterAiWrite({ shown: encodeURIComponent('C$ '), userConfiguration: symbols, selectedKeymapAbbr: 'C$ ' });
    assert.equal(encoded.mock.callCount(), 0);
});
