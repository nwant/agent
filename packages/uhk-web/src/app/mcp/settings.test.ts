import { UHK_60_USER_CONFIG, UHK_80_USER_CONFIG, UHK_DEVICE_IDS, UserConfiguration, type McpSettingsGroupName } from 'uhk-common';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { UserConfigurationJson } from './config-diff.js';
import { SETTINGS_GROUPS } from './settings.js';
import { handleMcpTool, type McpDeviceInfo } from './tool-handler.js';

const uhk80: McpDeviceInfo = { connected: true, model: 'UHK 80', firmwareVersion: '18.0.3', halves: { left: true, right: true, merged: false } };
const keyLabel = () => '';

function fixture(json = UHK_80_USER_CONFIG, edit: (json: Record<string, unknown>) => void = () => undefined) {
    const copy = structuredClone(json) as Record<string, unknown>;
    edit(copy);
    return new UserConfiguration().fromJsonObject(copy);
}

interface SettingsGroupReply {
    available: boolean | 'unknown';
    reason?: string;
    setCommand?: string;
    notAvailableOnThisModel?: string[];
    values?: Record<string, unknown> & { hostConnections?: unknown; TrackballRight?: { id: string } };
}

interface SettingsReply {
    summary: string;
    groups: Record<string, SettingsGroupReply>;
}

function getSettings(state: Partial<Parameters<typeof handleMcpTool>[0]>, args?: Record<string, unknown>) {
    const reply = handleMcpTool({
        keyLabel, statusText: '', config: fixture(), info: uhk80, deviceId: UHK_DEVICE_IDS.UHK80_RIGHT, ...state,
    }, { name: 'get_settings', arguments: args });
    return { isError: reply.isError, text: reply.content[0].text, result: (reply.isError ? undefined : JSON.parse(reply.content[0].text)) as SettingsReply };
}

test('get_settings reads typing behavior from the current configuration, including unsaved edits', () => {
    const config = fixture(UHK_80_USER_CONFIG, json => {
        json.keystrokeDelay = 12;
    });
    const { result } = getSettings({ config }, { group: 'typingBehavior' });
    const { values } = result.groups.typingBehavior;
    assert.equal(values.keystrokeDelay, 12);
    assert.equal(values.doubletapTimeout, 400);
    assert.equal(values.secondaryRoleStrategy, 'Simple');
    assert.deepEqual(Object.keys(result.groups), ['typingBehavior']);
});

test('every top-level setting belongs to exactly one group, except the device name and save metadata', () => {
    const ungrouped = new Set([
        'keymaps', 'macros', 'deviceName',
        'userConfigMajorVersion', 'userConfigMinorVersion', 'userConfigPatchVersion', 'lastSaveAgentTag', 'lastSaveFirmwareTag',
    ]);
    const grouped = Object.values(SETTINGS_GROUPS).flatMap(group => group.fields);
    assert.equal(new Set(grouped).size, grouped.length, 'a field is in two groups');
    const serialized = Object.keys(fixture().toJsonObject() as UserConfigurationJson).filter(field => !ungrouped.has(field));
    assert.deepEqual([...grouped].sort(), serialized.sort());
});

test('get_settings returns every group on a UHK 80, with values that match unsaved-change entries', () => {
    const config = fixture(UHK_80_USER_CONFIG, json => {
        json.mouseMoveInitialSpeed = 9;
        json.batteryChargingMode = 'Stationary';
    });
    const baseline = fixture().toJsonObject() as UserConfigurationJson;
    const { result } = getSettings({ config, baseline });
    assert.deepEqual(Object.keys(result.groups), ['typingBehavior', 'mouseKeySpeed', 'led', 'battery', 'connections', 'modules']);
    for (const group of Object.values(result.groups)) {
        assert.equal(group.available, true);
        assert.match(group.setCommand ?? '', /^set /);
    }
    const { groups } = result;
    assert.equal(groups.mouseKeySpeed.values.mouseMoveInitialSpeed, 9);
    assert.equal(groups.led.values.backlightingMode, 'FunctionalBacklighting');
    assert.equal(groups.led.values.displayBrightnessBattery, 255);
    const slots = groups.connections.values.hostConnections as unknown[];
    assert.deepEqual(slots[0], { name: 'My PC', type: 'UsbRight' });
    assert.equal(slots.length, (UHK_80_USER_CONFIG.hostConnections as unknown[]).length);
    assert.equal(groups.connections.values.bluetoothAlwaysAdvertise, false);
    assert.deepEqual(Object.keys(groups.modules.values), ['KeyClusterLeft', 'TouchpadRight', 'TrackballRight', 'TrackpointRight']);
    assert.equal(groups.modules.values.TrackballRight.id, 'TrackballRight');
    assert.match(result.summary, /does not change the saved setting/);

    const unsaved = handleMcpTool({ keyLabel, statusText: '', config, baseline, info: uhk80 }, { name: 'get_unsaved_changes' });
    const { changes } = JSON.parse(unsaved.content[0].text) as { changes: Array<{ path: string; after: unknown }> };
    const other = Object.fromEntries(changes.map(entry => [entry.path, entry.after]));
    assert.deepEqual(other, { mouseMoveInitialSpeed: 9, batteryChargingMode: 'Stationary' });
    assert.equal(groups.battery.values.batteryChargingMode, 'Stationary');
});

test('get_settings reports battery, connections and battery-powered LED values as unavailable on a UHK 60', () => {
    const info = { ...uhk80, model: 'UHK 60 v2' };
    const { result } = getSettings({ config: fixture(UHK_60_USER_CONFIG), info, deviceId: UHK_DEVICE_IDS.UHK60V2_RIGHT });
    for (const name of ['battery', 'connections']) {
        assert.deepEqual(result.groups[name], { available: false, reason: 'Not available on UHK 60 v2.' });
    }
    const { led } = result.groups;
    assert.equal(led.available, true);
    assert.deepEqual(led.notAvailableOnThisModel, [
        'keyBacklightBrightnessBattery', 'keyBacklightFadeOutBatteryTimeout', 'displayBrightnessBattery', 'displayFadeOutBatteryTimeout',
    ]);
    assert.equal(led.values.displayBrightnessBattery, undefined);
    assert.equal(led.values.keyBacklightBrightness, UHK_60_USER_CONFIG.keyBacklightBrightness);
    assert.equal(result.groups.modules.available, true);
    assert.equal(result.groups.typingBehavior.available, true);
});

test('get_settings says model-specific availability is unknown while no keyboard is connected', () => {
    const info: McpDeviceInfo = { ...uhk80, connected: false, model: null, firmwareVersion: null };
    const { result } = getSettings({ info, deviceId: undefined });
    assert.equal(result.groups.battery.available, 'unknown');
    assert.equal(result.groups.connections.available, 'unknown');
    assert.equal(result.groups.battery.values, undefined);
    assert.equal(result.groups.led.values.displayBrightnessBattery, 255);
    assert.match(result.groups.led.reason, /UHK 80 only/);
});

test('get_settings asks the caller to retry while Agent is still loading, and rejects an unknown group', () => {
    assert.match(getSettings({ info: undefined }).text, /still loading/);
    const unknown = getSettings({}, { group: 'backlight' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Unknown settings group "backlight". Use one of: typingBehavior, mouseKeySpeed, led, battery, connections, modules/);
});

test('get_settings lists host connection names and types and never their addresses', () => {
    const address = 'a1:b2:c3:d4:e5:f6';
    const config = fixture(UHK_80_USER_CONFIG, json => {
        (json.hostConnections as unknown[])[1] = { type: 'BLE', address, switchover: true, name: 'Phone' };
        (json.hostConnections as unknown[])[2] = { type: 'Dongle', address: '11:22:33:44:55:66', switchover: false, name: 'Dongle' };
    });
    const { result, text } = getSettings({ config }, { group: 'connections' });
    assert.deepEqual((result.groups.connections.values.hostConnections as unknown[]).slice(0, 4), [
        { name: 'My PC', type: 'UsbRight' }, { name: 'Phone', type: 'BLE' }, { name: 'Dongle', type: 'Dongle' }, { type: 'Empty' },
    ]);
    assert.equal(text.includes(address), false);
    assert.equal(text.includes('11:22:33:44:55:66'), false);
    assert.equal(/address|switchover/i.test(text), false);
});


interface SettingsUpdateReply {
    group: McpSettingsGroupName;
    values: Record<string, unknown>;
    errors: unknown[];
    riskFlags: string[];
    summary: string;
}

function updateSettings(group: unknown, values: unknown, overrides: Partial<Parameters<typeof handleMcpTool>[0]> = {}) {
    const config = overrides.config ?? fixture();
    const baseline = config.toJsonObject();
    const state = { keyLabel, statusText: '', info: uhk80, deviceId: UHK_DEVICE_IDS.UHK80_RIGHT, config, baseline, ...overrides };
    const result = handleMcpTool(state, { name: 'update_settings', arguments: { group, values } });
    assert.deepEqual(config.toJsonObject(), baseline, 'the original configuration stays unchanged');
    return { result, state, text: result.content[0].text };
}

test('update_settings proposes a partial change in every writable group and tags its unsaved diff', () => {
    const tests = [
        { group: 'typingBehavior', values: { keystrokeDelay: 12 }, paths: ['keystrokeDelay'] },
        { group: 'mouseKeySpeed', values: { mouseMoveInitialSpeed: 19, mouseMoveAxisSkew: 1.25 }, paths: ['mouseMoveAxisSkew', 'mouseMoveInitialSpeed'] },
        { group: 'led', values: { displayBrightness: 150, backlightingNoneActionColor: { r: 30, g: 20, b: 10 } }, paths: ['backlightingNoneActionColor', 'displayBrightness'] },
        { group: 'battery', values: { batteryChargingMode: 'Stationary', keyBacklightBrightnessChargingDefault: 75 }, paths: ['batteryChargingMode', 'keyBacklightBrightnessChargingDefault'] },
        { group: 'modules', values: { TrackballRight: { speed: 3.25 }, TouchpadRight: { navigationModeFnLayer: 'Scroll' } }, paths: ['moduleConfigurations'] },
    ] as const;
    for (const { group, values, paths } of tests) {
        const { result, state, text } = updateSettings(group, values);
        assert.equal(result.isError, false, text);
        assert.ok(result.next);
        const body = JSON.parse(text) as SettingsUpdateReply;
        assert.equal(body.group, group);
        assert.deepEqual(body.errors, []);
        assert.deepEqual(body.riskFlags, ['changesKeyboard']);
        assert.match(body.summary, /unsaved changes.*Save to keyboard/);

        const pending = { ...state, ...result.next };
        const before = getSettings(state, { group }).result.groups[group].values;
        const after = getSettings(pending, { group }).result.groups[group].values;
        const expected: Record<string, unknown> = { ...before, ...values };
        if (group === 'modules') {
            for (const [id, patch] of Object.entries(values)) {
                expected[id] = { ...(before[id] as object), ...patch };
            }
        }
        assert.deepEqual(body.values, after);
        assert.deepEqual(after, expected);

        const unsaved = handleMcpTool(pending, { name: 'get_unsaved_changes' });
        const { changes } = JSON.parse(unsaved.content[0].text) as {
            changes: Array<{ path: string; type: string; aiTagged: boolean; riskFlags: string[] }>;
        };
        assert.deepEqual(changes.map(entry => entry.path).sort(), paths);
        for (const entry of changes) {
            assert.equal(entry.type, 'other');
            assert.equal(entry.aiTagged, true);
            assert.deepEqual(entry.riskFlags, ['changesKeyboard']);
        }
    }
});

test('update_settings refuses malformed and out-of-range values atomically and names the invalid setting', () => {
    for (const { group, values, error } of [
        { group: 'typingBehavior', values: { keystrokeDelay: 12, unknownSetting: 0 }, error: /typingBehavior\.unknownSetting/ },
        { group: 'typingBehavior', values: { keystrokeDelay: 51 }, error: /keystrokeDelay.*0 to 50/ },
        { group: 'typingBehavior', values: { secondaryRoleAdvancedStrategyTriggerFromSameHalf: 'true' }, error: /secondaryRoleAdvancedStrategyTriggerFromSameHalf.*boolean/ },
        { group: 'mouseKeySpeed', values: { mouseMoveInitialSpeed: 2.5 }, error: /mouseMoveInitialSpeed.*integer/ },
        { group: 'mouseKeySpeed', values: { mouseScrollAxisSkew: Infinity }, error: /mouseScrollAxisSkew.*0\.1 to 10/ },
        { group: 'battery', values: { batteryChargingMode: '0' }, error: /batteryChargingMode.*Full, Stationary/ },
        { group: 'battery', values: { keyBacklightBrightnessChargingDefault: 101 }, error: /keyBacklightBrightnessChargingDefault.*0 to 100/ },
        { group: 'led', values: { displayFadeOutTimeout: 3601 }, error: /displayFadeOutTimeout.*0 to 3600/ },
        { group: 'led', values: { backlightingMode: 'ConstantRGB' }, error: /backlightingMode.*FunctionalBacklighting, PerKeyBacklighting/ },
        { group: 'led', values: { backlightingNoneActionColor: { r: -1, g: 0, b: 0 } }, error: /backlightingNoneActionColor\.r.*0 to 255/ },
        { group: 'led', values: { backlightingNoneActionColor: { red: 1 } }, error: /backlightingNoneActionColor\.red/ },
        { group: 'modules', values: { TrackballRight: { speed: 3 }, TouchpadRight: { touchpadPinchToZoom: 'Cursor' } }, error: /TouchpadRight\.touchpadPinchToZoom/ },
        { group: 'modules', values: { TrackpointRight: { keyClusterSwapAxes: true } }, error: /TrackpointRight\.keyClusterSwapAxes/ },
        { group: 'modules', values: { TrackballRight: { speed: -1 } }, error: /TrackballRight\.speed.*0 to 10/ },
        { group: 'modules', values: { Left: {} }, error: /Unknown module modules\.Left/ },
        { group: 'led', values: null, error: /values must be an object/ },
        { group: 'unknown', values: {}, error: /Unknown settings group/ },
    ]) {
        const { result, text } = updateSettings(group, values);
        assert.equal(result.isError, true, text);
        assert.match(text, error);
        assert.equal(result.next, undefined);
    }
});

test('update_settings refuses UHK 80 values on other models and omits them from otherwise valid LED replies', () => {
    const state = { config: fixture(UHK_60_USER_CONFIG), info: { ...uhk80, model: 'UHK 60 v2' }, deviceId: UHK_DEVICE_IDS.UHK60V2_RIGHT };
    for (const [group, field, value] of [
        ['battery', 'batteryChargingMode', 'Stationary'],
        ['led', 'displayBrightnessBattery', 100],
    ] as const) {
        const { result, text } = updateSettings(group, { [field]: value }, state);
        assert.equal(result.isError, true);
        assert.ok(text.includes(`${group}.${field} is only available on UHK 80. Current model: UHK 60 v2.`));
        assert.equal(result.next, undefined);
    }

    const { result, text } = updateSettings('led', { displayBrightness: 150 }, state);
    assert.equal(result.isError, false, text);
    const { values } = JSON.parse(text) as SettingsUpdateReply;
    assert.equal(values.displayBrightness, 150);
    assert.equal(values.displayBrightnessBattery, undefined);
});

test('update_settings refuses connections and keeps host details out of other write replies', () => {
    const config = fixture(UHK_80_USER_CONFIG, json => {
        (json.hostConnections as unknown[])[1] = { type: 'BLE', address: 'a1:b2:c3:d4:e5:f6', switchover: true, name: 'Test host' };
    });
    const refused = updateSettings('connections', { bluetoothAlwaysAdvertise: true }, { config });
    assert.equal(refused.result.isError, true);
    assert.match(refused.text, /connections is read-only/);
    assert.equal(refused.result.next, undefined);

    const wrongGroup = updateSettings('led', { hostConnections: [] }, { config });
    assert.equal(wrongGroup.result.isError, true);
    assert.match(wrongGroup.text, /led.hostConnections/);
    assert.equal(wrongGroup.result.next, undefined);

    const accepted = updateSettings('led', { displayBrightness: 150 }, { config });
    assert.equal(accepted.result.isError, false, accepted.text);
    assert.deepEqual(accepted.result.next.config.toJsonObject().hostConnections, config.toJsonObject().hostConnections);
    for (const { text } of [refused, wrongGroup, accepted]) {
        assert.doesNotMatch(text, /a1:b2:c3:d4:e5:f6|switchover|Test host/);
    }
});

test('update_settings preserves omitted typing fields and refuses changes the Simple preset would reset', () => {
    const values = { secondaryRoleAdvancedStrategyTimeout: 750 };
    const refused = updateSettings('typingBehavior', values);
    assert.equal(refused.result.isError, true);
    assert.match(refused.text, /secondaryRoleAdvancedStrategyTimeout.*Simple preset.*Advanced/);

    const accepted = updateSettings('typingBehavior', { secondaryRoleStrategy: 'Advanced', ...values });
    assert.equal(accepted.result.isError, false, accepted.text);
    const { config } = accepted.result.next;
    const read = config.toJsonObject();
    assert.equal(read.secondaryRoleStrategy, 'Advanced');
    assert.equal(read.secondaryRoleAdvancedStrategyTimeout, 750);
    assert.equal(read.secondaryRoleAdvancedStrategyMinimumHoldTime, accepted.state.config.secondaryRoleAdvancedStrategyMinimumHoldTime);
    const simple = updateSettings('typingBehavior', { secondaryRoleStrategy: 'Simple' }, { config });
    assert.equal(simple.result.isError, true);
    assert.match(simple.text, /secondaryRoleAdvancedStrategyTimeout/);
});

test('update_settings enables the per-key color data required by per-key backlighting', () => {
    const { result, text } = updateSettings('led', { backlightingMode: 'PerKeyBacklighting' });
    assert.equal(result.isError, false, text);
    assert.equal(result.next.config.perKeyRgbPresent, true);
    assert.equal(result.next.config.toJsonObject().backlightingMode, 'PerKeyBacklighting');
});

test('each set command hint names commands in the firmware reference manual', () => {
    const manual = readFileSync(new URL('./fixtures/firmware-v18.0.3/reference-manual.md', import.meta.url), 'utf8');
    const prefixes = Object.values(SETTINGS_GROUPS).flatMap(({ setCommand }) => [...setCommand.matchAll(/set ([A-Za-z.]*[A-Za-z])/g)].map(match => match[1]));
    assert.equal(prefixes.length, 10);
    for (const prefix of prefixes) {
        assert.ok(manual.includes(`set ${prefix}`), `${prefix} is not in the manual`);
    }
    for (const id of ['keycluster', 'trackball', 'trackpoint', 'touchpad']) {
        assert.ok(manual.includes(id), id);
    }
});
