import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcpTool } from './tool-handler.js';

const call = { name: 'get_device_info' };

test('get_device_info serializes the current device info', () => {
    const info = {
        connected: true,
        model: 'UHK 80',
        firmwareVersion: '18.0.5',
        halves: { left: true, right: true, merged: false },
    };
    const reply = handleMcpTool(info, call);
    assert.deepEqual(JSON.parse(reply.content[0].text), info);
    assert.notEqual(reply.isError, true);
});

test('get_device_info asks the caller to retry while Agent is still loading', () => {
    const reply = handleMcpTool(undefined, call);
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /still loading/);
});

test('unknown tools return a clear error', () => {
    const reply = handleMcpTool(undefined, { name: 'save_to_keyboard' });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /Unknown tool/);
});
