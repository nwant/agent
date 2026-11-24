import assert from 'node:assert/strict';
import { test } from 'node:test';
import { require as loadTs } from 'tsx/cjs/api';
import { SaveConfigurationAction } from './actions/device.js';

// Initialize the renderer globals before loading the effects and their store selectors.
Object.assign(globalThis, { window: { getUhkTheme: () => 'light' } });
const { actions, automaticSaves, reducers }: typeof import('../../../test/automatic-save.js') =
    loadTs('../../../test/automatic-save.ts', import.meta.url);

for (const [name, run] of Object.entries(automaticSaves)) {
    test(`${name} requests an automatic save`, async () => {
        assert.deepEqual((await run()).map(action => ({ ...action })), [{ ...new SaveConfigurationAction(true, true) }]);
    });
}

test('a paused automatic save shows Save to keyboard as a save the user asks for', () => {
    const { reducer, initialState } = reducers.device;
    const { saveToKeyboard } = reducer(initialState, new actions.AutomaticSavePausedAction());
    assert.equal(saveToKeyboard.showButton, true);
    assert.equal(saveToKeyboard.showProgress, false);
    assert.equal((saveToKeyboard.action as SaveConfigurationAction).automatic, false);
});

test('an automatic save paused during another save keeps the button afterwards', () => {
    const { reducer, initialState } = reducers.device;
    const saving = { ...initialState, saveToKeyboard: { ...initialState.saveToKeyboard, showButton: true, showProgress: true } };
    assert.equal(reducer(saving, new actions.AutomaticSavePausedAction()).modifiedConfigWhileSaved, true);
});

for (const [name, start, success] of [
    ['pairing', new actions.StartDonglePairingAction(), new actions.DonglePairingSuccessAction('')],
    ['deletion', { type: new actions.DeleteHostConnectionAction(undefined).type }, new actions.DeleteHostConnectionSuccessAction({ index: 0, address: '' })],
] as const) {
    test(`a paused save ends a finished dongle ${name} without reporting a failure`, () => {
        const { reducer, initialState } = reducers.dongle;
        const finished = [start, success].reduce(reducer, initialState);
        assert.deepEqual(reducer(finished, new actions.AutomaticSavePausedAction()), initialState);
    });
}

test('a paused save leaves a dongle pairing that is still running', () => {
    const { reducer, initialState } = reducers.dongle;
    const pairing = reducer(initialState, new actions.StartDonglePairingAction());
    assert.equal(reducer(pairing, new actions.AutomaticSavePausedAction()), pairing);
});

test('a paused save keeps the paired devices in the configuration and closes their panel', () => {
    const { reducer, initialState } = reducers.userConfig;
    const adding = { ...initialState, newPairedDevicesAdding: true, newPairedDevices: [{ address: 'aa', slot: 0 }] as typeof initialState.newPairedDevices };
    const paused = reducer(adding, new actions.AutomaticSavePausedAction());
    assert.equal(paused.newPairedDevicesAdding, false);
    assert.deepEqual(paused.newPairedDevices, []);
    assert.equal(paused.userConfiguration, adding.userConfiguration);
});
