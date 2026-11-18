import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcpTool } from './tool-handler.js';

test('get_device_info reports a connected UHK with firmware and physical halves', () => {
    const reply = handleMcpTool({
        connected: true,
        communicationAvailable: true, hasPermission: true, bootloaderActive: false,
        model: 'UHK 80',
        firmwareVersion: '18.0.5',
        halves: { left: true, right: true, merged: false },
    }, { name: 'get_device_info' });
    assert.deepEqual(JSON.parse(reply.content[0].text), {
        connected: true,
        model: 'UHK 80',
        firmwareVersion: '18.0.5',
        halves: { left: true, right: true, merged: false },
    });
    assert.notEqual(reply.isError, true);
});

test('get_device_info reports no keyboard without leaking stale model, firmware or halves', () => {
    const reply = handleMcpTool({
        connected: false,
        communicationAvailable: true, hasPermission: true, bootloaderActive: false,
        model: 'UHK 80',
        firmwareVersion: '18.0.5',
        halves: { left: true, right: true, merged: true },
    }, { name: 'get_device_info' });
    assert.deepEqual(JSON.parse(reply.content[0].text), {
        connected: false,
        model: null,
        firmwareVersion: null,
        halves: { left: false, right: false, merged: false },
    });
});

test('unknown tools return a clear error', () => {
    const reply = handleMcpTool({
        connected: false, communicationAvailable: false, hasPermission: true, bootloaderActive: false, model: null, firmwareVersion: null,
        halves: { left: false, right: false, merged: false },
    }, { name: 'save_to_keyboard' });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /Unknown tool/);
});

test('recovery or unavailable communication cannot report default halves as observed device info', () => {
    const reply = handleMcpTool({
        connected: true,
        communicationAvailable: false, hasPermission: true, bootloaderActive: false,
        model: 'UHK 80',
        firmwareVersion: null,
        halves: { left: true, right: true, merged: true },
    }, { name: 'get_device_info' });
    assert.deepEqual(JSON.parse(reply.content[0].text), {
        connected: false, model: null, firmwareVersion: null,
        halves: { left: false, right: false, merged: false },
    });
});

for (const unavailable of [{ hasPermission: false }, { bootloaderActive: true }]) {
    test(`get_device_info reports unavailable hardware for ${JSON.stringify(unavailable)}`, () => {
        const reply = handleMcpTool({
            connected: true, communicationAvailable: true, hasPermission: true, bootloaderActive: false,
            model: 'UHK 80', firmwareVersion: '18.0.5',
            halves: { left: true, right: true, merged: true },
            ...unavailable,
        }, { name: 'get_device_info' });
        assert.deepEqual(JSON.parse(reply.content[0].text), {
            connected: false, model: null, firmwareVersion: null,
            halves: { left: false, right: false, merged: false },
        });
    });
}
