import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { require as loadTs } from 'tsx/cjs/api';
import type { McpToolReply, UhkDeviceProduct } from 'uhk-common';
import type { UserConfigurationJson } from '../mcp/config-diff.js';
import { ActionTypes as AppActions, type ShowNotificationAction } from '../store/actions/app.js';
import { ActionTypes, type SaveConfigurationAction } from '../store/actions/device.js';

// Initialize the renderer globals before loading the service and its store selectors.
Object.assign(globalThis, { window: { getUhkTheme: () => 'light' } });
const { actions, setupAiSave }: typeof import('../../../test/ai-save.js') = loadTs('../../../test/ai-save.ts', import.meta.url);

const read = (reply: McpToolReply): { result?: string; message: string; changes?: unknown } => JSON.parse(reply.content[0].text);

// A fake clock lets a save that gets no answer time out at once instead of holding up the tests.
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] }));
afterEach(() => mock.timers.reset());

function settle(pending: Promise<McpToolReply>): Promise<McpToolReply> {
    mock.timers.tick(60_000);
    return pending;
}

test('a save reports success with the number of changes and shows a notice', async () => {
    const { save, start, emit, dispatched } = setupAiSave();
    const pending = save();
    const request = dispatched[0] as SaveConfigurationAction;
    assert.equal(request.type, ActionTypes.SaveConfiguration);
    assert.equal(request.payload, true);
    assert.equal(request.automatic, false);
    emit(new actions.SaveToKeyboardSuccessAction(start()));
    const reply = await settle(pending);
    assert.equal(reply.isError, false);
    const body = read(reply);
    assert.equal(body.result, 'saved');
    assert.equal(body.changes, 1);
    assert.match(body.message, /press the key.*get_macro_errors/);
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].type, AppActions.AppShowNotification);
    assert.match((dispatched[1] as ShowNotificationAction).payload.message, /AI client saved 1 change\b/);
});

test('a keyboard error is reported as failed without claiming that nothing was written', async () => {
    const { save, start, emit, dispatched } = setupAiSave();
    const pending = save();
    emit(new actions.SaveToKeyboardSuccessFailed({ configuration: start(), message: 'USB error' }));
    const reply = await settle(pending);
    assert.equal(reply.isError, true);
    const body = read(reply);
    assert.equal(body.result, 'failed');
    assert.match(body.message, /USB error.*may have been written/);
    assert.equal(dispatched.length, 1);
});

test('a save turned away before the write says nothing was written', async () => {
    const { save, emit } = setupAiSave();
    const pending = save();
    emit(new actions.SaveToKeyboardSuccessFailed());
    const body = read(await settle(pending));
    assert.equal(body.result, 'failed');
    assert.match(body.message, /Nothing was written/);
});

test('the outcome of another save is not reported as this one', async () => {
    for (const result of ['saved', 'failed']) {
        const { save, start, emit, otherRequest } = setupAiSave();
        const pending = save();
        const own = start();
        const other = start(otherRequest());
        const succeeded = (configuration: typeof own) => emit(new actions.SaveToKeyboardSuccessAction(configuration));
        const failed = (configuration: typeof own) => emit(new actions.SaveToKeyboardSuccessFailed({ configuration, message: 'USB error' }));
        emit(new actions.SaveToKeyboardSuccessFailed());
        if (result === 'saved') {
            failed(other);
            succeeded(own);
        } else {
            succeeded(other);
            failed(own);
        }
        assert.equal(read(await settle(pending)).result, result);
    }
});

test('a keyboard that does not answer leaves the result unknown', async () => {
    const { save, start } = setupAiSave();
    const pending = save();
    start();
    const reply = await settle(pending);
    assert.equal(reply.isError, true);
    const body = read(reply);
    assert.equal(body.result, 'unknown');
    assert.match(body.message, /may or may not/);
});

test('a second save is refused while one is running, and allowed afterwards', async () => {
    const { save, start, emit, dispatched } = setupAiSave();
    const first = save();
    const second = save();
    assert.equal(dispatched.length, 1);
    assert.match(read(await second).message, /busy/);
    emit(new actions.SaveToKeyboardSuccessAction(start()));
    await settle(first);
    const third = save();
    assert.equal(dispatched.length, 3);
    emit(new actions.SaveToKeyboardSuccessFailed());
    await settle(third);
});

test('a save without permission dispatches nothing', async () => {
    const { save, dispatched } = setupAiSave();
    const reply = await settle(save(false));
    assert.equal(reply.isError, true);
    assert.match(read(reply).message, /Let AI clients save to the keyboard/);
    assert.deepEqual(dispatched, []);
});

for (const [response, result] of [
    [{ success: true }, 'saved'], [{ success: false, error: { message: 'USB error' } }, 'failed'],
] as const) {
    test(`a save runs through Agent's save path and reports that the keyboard answered: ${result}`, async () => {
            const { save, connectSaveEffects, answerFromKeyboard, sent } = setupAiSave();
        connectSaveEffects();
        const pending = save();
        mock.timers.tick(100);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].saveInHistory, true);
        assert.ok((sent[0].configuration as unknown as UserConfigurationJson).macros.some(({ name }) => name === 'Added by AI'));
        answerFromKeyboard(response);
        assert.equal(read(await settle(pending)).result, result);
    });
}

test('a configuration that cannot be serialized is refused without saving', async () => {
    const { save, dispatched } = setupAiSave({ unserializable: true });
    const reply = await settle(save());
    assert.equal(reply.isError, true);
    assert.match(read(reply).message, /Nothing was written/);
    assert.deepEqual(dispatched, []);
});

for (const [name, change, message] of [
    ['is loading the configuration', { app: { configLoading: true } }, /busy/],
    ['is saving', { device: { saveToKeyboard: { showProgress: true } } }, /busy/],
    ['is updating firmware', { firmware: { upgradeState: 'Started' } }, /busy/],
    ['is pairing a dongle', { dongle: { operation: 'Pairing' } }, /busy/],
    ['is pairing the halves', { advanceSettings: { isLeftHalfPairing: true } }, /busy/],
    ['has no keyboard', { device: { connectedDevice: undefined as UhkDeviceProduct } }, /No keyboard/],
    ['has too little keyboard space', { device: { configSizes: { userConfig: 10 } } }, /space/],
    ['needs a firmware update', { device: { skipFirmwareUpgrade: true, modules: { rightModuleInfo: { userConfigVersion: '1.0.0' } } } }, /firmware must be updated/],
    ['has a configuration too new for the firmware', { device: { modules: { rightModuleInfo: { userConfigVersion: '1.0.0' } } } }, /too new/],
] as const) {
    test(`a save is refused without moving the user when Agent ${name}`, async () => {
        const { save, dispatched } = setupAiSave(change);
        const reply = await settle(save());
        assert.equal(reply.isError, true);
        assert.match(read(reply).message, message);
        assert.deepEqual(dispatched, []);
    });
}
