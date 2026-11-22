import assert from 'node:assert/strict';
import { test } from 'node:test';
import { require as loadTs } from 'tsx/cjs/api';
import { UHK_80_USER_CONFIG, UserConfiguration } from 'uhk-common';
import type { MacroJson } from '../../mcp/config-diff.js';
import { SaveToKeyboardSuccessAction } from '../actions/device.js';

test('save success clears saved AI tags and keeps changes made after the snapshot', () => {
    // The renderer reducer reads the current theme at module initialization.
    Object.assign(globalThis, { window: { getUhkTheme: () => 'light' } });
    const { initialState, reducer }: typeof import('./user-configuration.js') =
        loadTs('./user-configuration.ts', import.meta.url);

    const baseline = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG)).toJsonObject();
    const macro: MacroJson = { name: 'Saved', isLooped: false, isPrivate: false, macroActions: [] };
    const saved = new UserConfiguration().fromJsonObject({
        ...baseline, macros: [...baseline.macros, macro, { ...macro, name: 'Edited again' }],
    }).toJsonObject();
    const current = new UserConfiguration().fromJsonObject({
        ...saved, macros: [...saved.macros, { ...macro, name: 'New' }],
    });
    current.macros.find(entry => entry.name === 'Edited again').isPrivate = true;
    const state = reducer({
        ...initialState,
        keyboardBaseline: baseline,
        userConfiguration: current,
        aiTags: ['macro:Saved', 'macro:Edited again', 'macro:New'],
    }, new SaveToKeyboardSuccessAction(saved));

    assert.equal(state.keyboardBaseline, saved);
    assert.deepEqual(state.aiTags, ['macro:Edited again', 'macro:New']);
});
