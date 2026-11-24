import assert from 'node:assert/strict';
import { test } from 'node:test';
import { require as loadTs } from 'tsx/cjs/api';
import {
    emptyHostConnection, HOST_CONNECTION_COUNT_MAX, NotificationType, UHK_80_USER_CONFIG, UHK_DEVICE_IDS, UserConfiguration,
} from 'uhk-common';
import { ActionTypes as AppActions, type ShowNotificationAction } from '../actions/app.js';
import {
    ActionTypes, RecoveryDeviceAction, SaveConfigurationAction,
} from '../actions/device.js';

// Initialize the renderer globals before loading the effects and their store selectors.
Object.assign(globalThis, { window: { getUhkTheme: () => 'light' } });
const { runRequest }: typeof import('../../../../test/configuration-write.js') =
    loadTs('../../../../test/configuration-write.ts', import.meta.url);

test('saving with a required firmware upgrade redirects and stops before review', async () => {
    const { types, navigate, authorize } = await runRequest(new SaveConfigurationAction(true), {
        skipFirmwareUpgrade: true, firmwareConfigVersion: '1.0.0',
    });
    assert.deepEqual(types, [ActionTypes.SaveToKeyboardFailed]);
    assert.deepEqual(navigate.mock.calls.map(call => call.arguments), [[['/update-firmware']]]);
    assert.equal(authorize.mock.callCount(), 0);
});

test('saving with too many host connections redirects and stops before review', async () => {
    const userConfig = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    userConfig.hostConnections = Array.from({ length: HOST_CONNECTION_COUNT_MAX + 1 }, () => emptyHostConnection());
    const { types, navigate, authorize } = await runRequest(new SaveConfigurationAction(true), { userConfig });
    assert.deepEqual(types, [ActionTypes.SaveToKeyboardFailed]);
    assert.deepEqual(navigate.mock.calls.map(call => call.arguments), [[['/device/host-connections']]]);
    assert.equal(authorize.mock.callCount(), 0);
});

test('saving a newer configuration reports an error and stops before review', async () => {
    const { emitted, types, authorize } = await runRequest(new SaveConfigurationAction(true), { firmwareConfigVersion: '1.0.0' });
    assert.deepEqual(types, [AppActions.AppShowNotification, ActionTypes.SaveToKeyboardFailed]);
    const notification = (emitted[0] as ShowNotificationAction).payload;
    assert.equal(notification.type, NotificationType.Error);
    assert.match(notification.message, /configuration version.*too high.*1\.0\.0/i);
    assert.equal(authorize.mock.callCount(), 0);
});

test('a browser save starts without desktop confirmation', async () => {
    const { types, authorize } = await runRequest(new SaveConfigurationAction(true), { electron: false });
    assert.deepEqual(types, [ActionTypes.ConfigurationWriteStarted]);
    assert.equal(authorize.mock.callCount(), 0);
});

for (const device of [UHK_DEVICE_IDS.UHK80_LEFT, UHK_DEVICE_IDS.UHK_DONGLE]) {
    test(`recovery of device ${device} starts without configuration review`, async () => {
        const { types, authorize } = await runRequest(new RecoveryDeviceAction(device));
        assert.deepEqual(types, [ActionTypes.ConfigurationWriteStarted]);
        assert.equal(authorize.mock.callCount(), 0);
    });
}

test('an approved desktop save starts the write', async () => {
    const { types, authorize } = await runRequest(new SaveConfigurationAction(true));
    assert.equal(authorize.mock.callCount(), 1);
    assert.deepEqual(types, [ActionTypes.ConfigurationWriteStarted]);
});

test('an automatic save pauses for review while AI-tagged changes are waiting', async () => {
    const { emitted, types, authorize } = await runRequest(new SaveConfigurationAction(true, true), { aiTags: ['macro:AI'] });
    assert.deepEqual(types, [ActionTypes.AutomaticSavePaused, AppActions.AppShowNotification]);
    const notification = (emitted[1] as ShowNotificationAction).payload;
    assert.equal(notification.type, NotificationType.Warning);
    assert.match(notification.message, /not saved yet.*review/i);
    assert.equal(authorize.mock.callCount(), 0);
});

test('an automatic save without AI-tagged changes starts the write', async () => {
    const { types, authorize } = await runRequest(new SaveConfigurationAction(true, true));
    assert.equal(authorize.mock.callCount(), 1);
    assert.deepEqual(types, [ActionTypes.ConfigurationWriteStarted]);
});

test('a save the user asked for starts the write with AI-tagged changes', async () => {
    const { types, authorize } = await runRequest(new SaveConfigurationAction(true), { aiTags: ['macro:AI'] });
    assert.equal(authorize.mock.callCount(), 1);
    assert.deepEqual(types, [ActionTypes.ConfigurationWriteStarted]);
});

test('an automatic browser save ignores AI tags', async () => {
    const { types } = await runRequest(new SaveConfigurationAction(true, true), { electron: false, aiTags: ['macro:AI'] });
    assert.deepEqual(types, [ActionTypes.ConfigurationWriteStarted]);
});
