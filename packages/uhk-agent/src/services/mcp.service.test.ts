import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DEFAULT_MCP_SETTINGS, IpcEvents, LogService, McpSettings, McpStatus } from 'uhk-common';
import { McpService } from './mcp.service';
import { availablePort, httpRequest } from '../mcp/test-http';

class SettingsIpc extends EventEmitter {
    readonly handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    handle(channel: string, listener: Parameters<IpcMain['handle']>[1]): void {
        this.handlers.set(channel, listener);
    }
}

function setup(saved?: unknown, beforeSave?: (settings: McpSettings) => Promise<void>) {
    const ipc = new SettingsIpc();
    const frame = {};
    const sender = { mainFrame: frame };
    let destroyed = false;
    const win = { webContents: sender, isDestroyed: () => destroyed } as unknown as BrowserWindow;
    let stored = saved;
    const logger = new LogService();
    const errors: unknown[][] = [];
    logger.error = (...args: unknown[]) => { errors.push(args); };
    const service = new McpService(logger, win, {
        ipc,
        readReferenceManual: async () => { throw new Error('Unexpected reference manual read'); },
        settings: {
            get: async () => structuredClone(stored),
            set: async (_key, value) => {
                await beforeSave?.(value);
                stored = structuredClone(value);
            },
        },
    });
    const invoke = async (channel: string, input?: unknown, event: { sender: unknown; senderFrame: unknown } = { sender, senderFrame: frame }): Promise<McpStatus> => {
        return ipc.handlers.get(channel)(event as unknown as IpcMainInvokeEvent, input);
    };
    return { service, invoke, sender, frame, errors, destroyWindow: () => { destroyed = true; }, stored: () => stored as McpSettings };
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
    assert.deepEqual(fixture.stored(), { enabled: false, port: 53417, token: status.token, revealTextMacros: false, allowSave: false });
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
    fixture.destroyWindow();
    await assert.rejects(fixture.invoke(IpcEvents.mcp.getSettings), /Unknown Agent window/);
    assert.deepEqual(fixture.stored(), { enabled: false, port: 53418, token, revealTextMacros: false, allowSave: false });
});

test('enable, regenerate, restart and disable control the listener and durable credential', async context => {
    const port = await availablePort();
    const fixture = setup({ enabled: false, port, token });
    context.after(() => fixture.service.stop());
    await fixture.service.start();
    await assert.rejects(httpRequest({ port, token }), { code: 'ECONNREFUSED' });
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
    assert.ok(fixture.errors.some(([message]) => message === `[McpService] Could not bind to 127.0.0.1:${port}`));
    assert.equal(fixture.stored().enabled, false);
});

test('quick configure requests apply in order even when the first write is pending', async context => {
    const port = await availablePort();
    const writing = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const writes: boolean[] = [];
    const fixture = setup({ enabled: false, port, token }, async settings => {
        writes.push(settings.enabled);
        if (settings.enabled) {
            writing.resolve();
            await releaseWrite.promise;
        }
    });
    context.after(() => fixture.service.stop());
    await fixture.service.start();

    const enable = fixture.invoke(IpcEvents.mcp.configure, { enabled: true, port, regenerateToken: false });
    const disable = fixture.invoke(IpcEvents.mcp.configure, { enabled: false, port, regenerateToken: false });
    try {
        await writing.promise;
        await setImmediate();
        assert.deepEqual(writes, [false, true]);
    } finally {
        releaseWrite.resolve();
    }

    const [enabled, disabled] = await Promise.all([enable, disable]);
    assert.equal(enabled.enabled, true);
    assert.equal(disabled.enabled, false);
    assert.deepEqual(writes, [false, true, false]);
    assert.equal(fixture.stored().enabled, false);
    await assert.rejects(httpRequest({ port, token }), { code: 'ECONNREFUSED' });
});

test('text macro reveal requires explicit opt-in and persists through restarts', async context => {
    const fixture = setup({ enabled: false, port: 53418, token, revealTextMacros: 'true' });
    context.after(() => fixture.service.stop());
    await fixture.service.start();
    assert.equal(fixture.stored().revealTextMacros, false);
    const input = { enabled: false, port: 53418, regenerateToken: false };
    await fixture.invoke(IpcEvents.mcp.configure, { ...input, revealTextMacros: 'false' });
    assert.equal(fixture.stored().revealTextMacros, false);
    await fixture.invoke(IpcEvents.mcp.configure, { ...input, revealTextMacros: true });
    const restarted = setup(fixture.stored());
    context.after(() => restarted.service.stop());
    await restarted.service.start();
    assert.equal((await restarted.invoke(IpcEvents.mcp.getSettings)).revealTextMacros, true);
    await restarted.invoke(IpcEvents.mcp.configure, { ...input, revealTextMacros: false });
    assert.equal(restarted.stored().revealTextMacros, false);
});

test('letting AI clients save requires explicit opt-in and persists through restarts', async context => {
    const port = await availablePort();
    const fixture = setup({ enabled: true, port, token, allowSave: 'true' });
    context.after(() => fixture.service.stop());
    await fixture.service.start();
    assert.equal(fixture.stored().allowSave, false);
    const input = { enabled: true, port, regenerateToken: false };
    await fixture.invoke(IpcEvents.mcp.configure, { ...input, allowSave: 'true' });
    assert.equal(fixture.stored().allowSave, false);
    await fixture.invoke(IpcEvents.mcp.configure, { ...input, allowSave: true });
    assert.equal(fixture.stored().allowSave, true);
    await fixture.service.stop();
    const restarted = setup(fixture.stored());
    context.after(() => restarted.service.stop());
    await restarted.service.start();
    assert.equal((await restarted.invoke(IpcEvents.mcp.getSettings)).allowSave, true);
});

for (const [name, change] of [
    ['turning AI access off', { enabled: false, regenerateToken: false }],
    ['regenerating the token', { enabled: true, regenerateToken: true }],
] as const) {
    test(`${name} stops AI clients from saving`, async context => {
        const port = await availablePort();
        const fixture = setup({ enabled: true, port, token, allowSave: true });
        context.after(() => fixture.service.stop());
        await fixture.service.start();
        const status = await fixture.invoke(IpcEvents.mcp.configure, { port, allowSave: true, ...change });
        assert.equal(status.allowSave, false);
        assert.equal(fixture.stored().allowSave, false);
    });
}

test('AI access that cannot start, or is saved as off, does not let AI clients save', async context => {
    const busy = createServer();
    await new Promise<void>(resolve => busy.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise<void>(resolve => busy.close(() => resolve())));
    const { port } = busy.address() as { port: number };
    for (const enabled of [true, false]) {
        const fixture = setup({ enabled, port, token, allowSave: true });
        context.after(() => fixture.service.stop());
        await fixture.service.start();
        assert.equal((await fixture.invoke(IpcEvents.mcp.getSettings)).allowSave, false);
        assert.equal(fixture.stored().allowSave, false);
    }
});
