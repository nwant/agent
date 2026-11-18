import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DEFAULT_MCP_SETTINGS, IpcEvents, McpSettings, McpStatus } from 'uhk-common';
import { McpService } from './mcp.service';
import { availablePort, httpRequest } from '../mcp/test-http';

class SettingsIpc extends EventEmitter {
    readonly handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    handle(channel: string, listener: Parameters<IpcMain['handle']>[1]): void {
        this.handlers.set(channel, listener);
    }
}

function setup(saved?: unknown) {
    const ipc = new SettingsIpc();
    const frame = {};
    const sender = { mainFrame: frame };
    let win = { webContents: sender } as unknown as BrowserWindow;
    let stored = saved;
    const service = new McpService({
        getWindow: () => win,
        ipc,
        settings: {
            get: async () => structuredClone(stored),
            set: async (_key, value) => { stored = structuredClone(value); },
        },
    });
    const invoke = async (channel: string, input?: unknown, event: { sender: unknown; senderFrame: unknown } = { sender, senderFrame: frame }): Promise<McpStatus> => {
        return ipc.handlers.get(channel)(event as unknown as IpcMainInvokeEvent, input);
    };
    return { service, invoke, sender, frame, noWindow: () => { win = undefined; }, stored: () => stored as McpSettings };
}

const token = 'a'.repeat(64);

test('AI access starts disabled, generates a token and persists application settings', async context => {
    const fixture = setup();
    context.after(() => fixture.service.stop());
    await fixture.service.start();
    const status = await fixture.invoke(IpcEvents.mcp.getSettings);
    assert.equal(status.enabled, false);
    assert.equal(status.port, DEFAULT_MCP_SETTINGS.port);
    assert.match(status.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(fixture.stored(), { enabled: false, port: 53417, token: status.token });
    await assert.rejects(httpRequest({ port: status.port, token: status.token }));
});

test('saved port and token are restored, with malformed saved values replaced', async context => {
    for (const saved of [
        { enabled: false, port: 53418, token },
        ...[undefined, 'invalid', '53418', 1023, 65536, 1234.5].map(port => ({ enabled: false, port, token })),
        ...[undefined, 42, 'invalid', { toString: 'invalid' }].map(token => ({ enabled: false, port: 53418, token })),
    ]) {
        const fixture = setup(saved);
        context.after(() => fixture.service.stop());
        await fixture.service.start();
        const result = await fixture.invoke(IpcEvents.mcp.getSettings);
        assert.equal(result.port, saved.port === 53418 ? 53418 : 53417);
        assert.match(result.token, /^[a-f0-9]{64}$/);
        if (saved.token === token) {
            assert.equal(result.token, token);
        }
    }
});

test('configure rejects invalid input and callers outside the Agent main frame', async context => {
    const fixture = setup({ enabled: false, port: 53418, token });
    context.after(() => fixture.service.stop());
    await fixture.service.start();
    const valid = { enabled: false, port: 53418, regenerateToken: false };
    for (const input of [null, { ...valid, enabled: 'yes' }, { ...valid, regenerateToken: 'yes' },
        ...[1023, 65536, 1234.5].map(port => ({ ...valid, port }))]) {
        await assert.rejects(fixture.invoke(IpcEvents.mcp.configure, input), /between 1024 and 65535/);
    }
    for (const event of [{ sender: {}, senderFrame: fixture.frame }, { sender: fixture.sender, senderFrame: {} }]) {
        await assert.rejects(fixture.invoke(IpcEvents.mcp.getSettings, undefined, event), /Unknown Agent window/);
        await assert.rejects(fixture.invoke(IpcEvents.mcp.configure, valid, event), /Unknown Agent window/);
    }
    fixture.noWindow();
    await assert.rejects(fixture.invoke(IpcEvents.mcp.getSettings), /Unknown Agent window/);
    assert.deepEqual(fixture.stored(), { enabled: false, port: 53418, token });
});

test('enable, regenerate, restart and disable control the listener and durable credential', async context => {
    const port = await availablePort();
    const fixture = setup({ enabled: false, port, token });
    context.after(() => fixture.service.stop());
    await fixture.service.start();
    await fixture.invoke(IpcEvents.mcp.configure, { enabled: true, port, regenerateToken: false });
    assert.equal((await httpRequest({ port, token, method: 'GET' })).status, 405);
    const rotated = await fixture.invoke(IpcEvents.mcp.configure, { enabled: true, port, regenerateToken: true });
    assert.notEqual(rotated.token, token);
    assert.equal((await httpRequest({ port, token, method: 'GET' })).status, 401);
    await fixture.service.stop();
    const restarted = setup(fixture.stored());
    context.after(() => restarted.service.stop());
    await restarted.service.start();
    assert.equal((await httpRequest({ port, token: rotated.token, method: 'GET' })).status, 405);
    await restarted.invoke(IpcEvents.mcp.configure, { enabled: false, port, regenerateToken: false });
    await assert.rejects(httpRequest({ port, token: rotated.token }));
    assert.equal(restarted.stored().enabled, false);
});

test('a busy port disables AI access and returns an actionable error', async context => {
    const busy = createServer();
    await new Promise<void>(resolve => busy.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise<void>(resolve => busy.close(() => resolve())));
    const port = (busy.address() as { port: number }).port;
    const fixture = setup({ enabled: true, port, token });
    context.after(() => fixture.service.stop());
    await fixture.service.start();
    const status = await fixture.invoke(IpcEvents.mcp.getSettings);
    assert.equal(status.enabled, false);
    assert.match(status.error, /Choose another port/);
    assert.equal(fixture.stored().enabled, false);
});
