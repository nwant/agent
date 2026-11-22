import { UHK_60_USER_CONFIG, UHK_80_USER_CONFIG, UHK_DEVICE_IDS, UserConfiguration } from 'uhk-common';
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
    assert.match(unknown.text, /Unknown settings group. Use one of: typingBehavior, mouseKeySpeed, led, battery, connections, modules/);
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
