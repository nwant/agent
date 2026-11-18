import assert from 'node:assert/strict';
import { test } from 'node:test';
import '@angular/compiler';
import { LeftSlotModules, RightSlotModules, UHK_80_DEVICE } from 'uhk-common';
import { getMcpDeviceInfo } from './mcp-device-info.selector.js';

const detected = {
    deviceConnectionStateLoaded: true,
    connectedDevice: UHK_80_DEVICE,
    communicationInterfaceAvailable: true,
    hasPermission: true,
    bootloaderActive: false,
    leftHalfBootloaderActive: false,
    modules: { rightModuleInfo: { firmwareVersion: '18.0.5', modules: {} } },
    halvesInfo: { leftModuleSlot: LeftSlotModules.NoModule, rightModuleSlot: RightSlotModules.NoModule, isLeftHalfConnected: true, areHalvesMerged: true },
};

test('device info stays pending before the first connection poll completes', () => {
    assert.equal(getMcpDeviceInfo({ device: { ...detected, deviceConnectionStateLoaded: false } }), undefined);
});

for (const [reason, override] of [
    ['no keyboard detected', { connectedDevice: undefined }],
    ['no communication interface', { communicationInterfaceAvailable: false }],
    ['no device permission', { hasPermission: false }],
    ['right half in bootloader mode', { bootloaderActive: true }],
    ['left half in bootloader mode', { leftHalfBootloaderActive: true }],
    ['dongle in bootloader mode', { dongle: { bootloaderActive: true, multiDevice: false, serialNumber: 'test' } }],
] as const) {
    test(`device info suppresses hardware details with ${reason}`, () => {
        assert.deepEqual(getMcpDeviceInfo({ device: { ...detected, ...override } }), {
            connected: false, model: null, firmwareVersion: null,
            halves: { left: false, right: false, merged: false },
        });
    });
}

test('device info reports the detected model, firmware and physical halves', () => {
    assert.deepEqual(getMcpDeviceInfo({ device: detected }), {
        connected: true, model: 'UHK 80', firmwareVersion: '18.0.5',
        halves: { left: true, right: true, merged: true },
    });
});

test('device info preserves connection and halves when the firmware version is unknown', () => {
    assert.deepEqual(getMcpDeviceInfo({
        device: { ...detected, modules: {}, halvesInfo: { ...detected.halvesInfo, isLeftHalfConnected: false, areHalvesMerged: false } },
    }), {
        connected: true, model: 'UHK 80', firmwareVersion: null,
        halves: { left: false, right: true, merged: false },
    });
});
