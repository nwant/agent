import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { IpcEvents, McpToolRequest } from 'uhk-common';
import { McpRendererBridge } from './renderer-bridge';

function setup() {
    const ipc = new EventEmitter();
    const renderer = Object.assign(new EventEmitter(), {
        isDestroyed: (): boolean => false,
        isLoadingMainFrame: (): boolean => false,
        send: (_channel: string, request: McpToolRequest) => { sent.push(request); },
    });
    const sent: McpToolRequest[] = [];
    const win = { isDestroyed: (): boolean => false, webContents: renderer } as unknown as BrowserWindow;
    const bridge = new McpRendererBridge({ getWindow: () => win, ipc });
    return { ipc, renderer, sent, win, bridge };
}

const call = { name: 'get_device_info' };
const reply = { content: [{ type: 'text' as const, text: 'device-info' }] };

test('bridge matches concurrent replies to their request and ignores another renderer', async () => {
    const { ipc, renderer, sent, bridge } = setup();
    const firstReply = { content: [{ type: 'text' as const, text: 'first keyboard' }] };
    const first = bridge.request(call);
    const second = bridge.request(call);
    assert.notEqual(sent[0].id, sent[1].id);
    ipc.emit(IpcEvents.mcp.response, { sender: {} }, [{ id: sent[0].id, reply: { content: [] } }]);
    ipc.emit(IpcEvents.mcp.response, { sender: renderer }, [{ id: sent[1].id, reply }]);
    ipc.emit(IpcEvents.mcp.response, { sender: renderer }, [{ id: sent[0].id, reply: firstReply }]);
    assert.deepEqual(await first, firstReply);
    assert.deepEqual(await second, reply);
    assert.equal(ipc.listenerCount(IpcEvents.mcp.response), 0);
});

test('bridge rejects requests without a live, loaded renderer', async () => {
    const ipc = new EventEmitter();
    await assert.rejects(new McpRendererBridge({ getWindow: () => undefined, ipc }).request(call), /unavailable/);
    for (const condition of ['window', 'webContents', 'loading']) {
        const { bridge, win, renderer } = setup();
        if (condition === 'window') { win.isDestroyed = () => true; }
        if (condition === 'webContents') { renderer.isDestroyed = () => true; }
        if (condition === 'loading') { renderer.isLoadingMainFrame = () => true; }
        await assert.rejects(bridge.request(call), /unavailable or still loading/);
    }
});

test('bridge times out instead of hanging and releases its listeners', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { ipc, bridge, renderer } = setup();
    const pending = assert.rejects(bridge.request(call), /did not reply within 10 seconds/);
    context.mock.timers.tick(10_000);
    await pending;
    assert.equal(ipc.listenerCount(IpcEvents.mcp.response), 0);
    assert.equal(renderer.listenerCount('destroyed'), 0);
});

test('bridge fails pending calls when the renderer closes, reloads or crashes', async () => {
    for (const event of ['destroyed', 'did-start-loading', 'render-process-gone']) {
        const { ipc, bridge, renderer } = setup();
        const pending = assert.rejects(bridge.request(call), /became unavailable/);
        renderer.emit(event);
        await pending;
        assert.equal(ipc.listenerCount(IpcEvents.mcp.response), 0);
    }
});

test('bridge reports a send failure and releases listeners', async () => {
    const { ipc, bridge, renderer } = setup();
    renderer.send = () => { throw new Error('closed'); };
    await assert.rejects(bridge.request(call), /became unavailable/);
    assert.equal(ipc.listenerCount(IpcEvents.mcp.response), 0);
});

test('bridge ignores empty replies and unknown request ids', async () => {
    const { ipc, renderer, sent, bridge } = setup();
    const pending = bridge.request(call);
    ipc.emit(IpcEvents.mcp.response, { sender: renderer }, []);
    ipc.emit(IpcEvents.mcp.response, { sender: renderer }, [{ id: 'unknown', reply: { content: [] } }]);
    ipc.emit(IpcEvents.mcp.response, { sender: renderer }, [{ id: sent[0].id, reply }]);
    assert.deepEqual(await pending, reply);
});

test('bridge sends the current permissions with each request and grants none by default', async () => {
    const { ipc, renderer, sent, bridge } = setup();
    for (const [index, permissions] of [undefined, { revealTextMacros: true, allowSave: true }].entries()) {
        const pending = bridge.request(call, permissions);
        ipc.emit(IpcEvents.mcp.response, { sender: renderer }, [{ id: sent[index].id, reply }]);
        await pending;
    }
    assert.deepEqual(sent.map(({ revealTextMacros, allowSave }) => ({ revealTextMacros, allowSave })), [
        { revealTextMacros: false, allowSave: false }, { revealTextMacros: true, allowSave: true },
    ]);
});

test('bridge waits longer for a save than for other calls', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { ipc, renderer, sent, bridge } = setup();
    const pending = bridge.request({ name: 'save_to_keyboard' });
    context.mock.timers.tick(60_000);
    ipc.emit(IpcEvents.mcp.response, { sender: renderer }, [{ id: sent[0].id, reply }]);
    assert.deepEqual(await pending, reply);
});

test('bridge reports an unanswered save as unknown, and one never sent as an error', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const interrupt of [
        () => context.mock.timers.tick(120_000),
        (renderer: EventEmitter) => renderer.emit('render-process-gone'),
    ]) {
        const { bridge, renderer } = setup();
        const pending = bridge.request({ name: 'save_to_keyboard' });
        interrupt(renderer);
        const result = await pending;
        assert.equal(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).result, 'unknown');
    }
    const { bridge, renderer } = setup();
    renderer.isLoadingMainFrame = () => true;
    await assert.rejects(bridge.request({ name: 'save_to_keyboard' }), /unavailable or still loading/);
});
