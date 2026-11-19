import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpToolReply } from 'uhk-common';
import { AgentMcpServer } from './server';
import { availablePort, httpRequest } from './test-http';

const toolCall = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_device_info', arguments: {} } };
const manualUri = 'uhk://smart-macro/reference-manual';
const manualRead = { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: manualUri } };
const unexpectedManual = async (): Promise<string> => { throw new Error('Unexpected reference manual read'); };

test('MCP advertises the smart-macro reference manual as Markdown', async context => {
    const port = await availablePort();
    const server = new AgentMcpServer(async () => { throw new Error('Unexpected renderer request'); }, unexpectedManual);
    context.after(() => server.stop());
    await server.start({ port, token: 'test-token', enabled: true });

    const listed = await httpRequest({ port, body: { jsonrpc: '2.0', id: 1, method: 'resources/list' } });
    const { resources } = JSON.parse(listed.text).result;
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, manualUri);
    assert.equal(resources[0].mimeType, 'text/markdown');
});

test('MCP reads the current reference manual and reports when it is unavailable', async context => {
    const port = await availablePort();
    let manual: string | Error = '# Reference manual for firmware A';
    const server = new AgentMcpServer(async () => { throw new Error('Unexpected renderer request'); }, async () => {
        if (manual instanceof Error) {
            throw manual;
        }
        return manual;
    });
    context.after(() => server.stop());
    await server.start({ port, token: 'test-token', enabled: true });

    assert.equal((await httpRequest({ port, token: 'wrong', body: manualRead })).status, 401);
    for (const text of ['# Reference manual for firmware A', '# Reference manual for firmware B']) {
        manual = text;
        const response = await httpRequest({ port, body: manualRead });
        assert.deepEqual(JSON.parse(response.text).result.contents, [{ uri: manualUri, mimeType: 'text/markdown', text }]);
    }
    for (const message of [
        'Connect a keyboard in Agent to read its smart-macro reference manual.',
        'The smart-macro reference manual is unavailable for the connected firmware.',
    ]) {
        manual = new Error(message);
        const response = await httpRequest({ port, body: manualRead });
        assert.equal(JSON.parse(response.text).error.message, message);
    }
});

test('HTTP enforces access before dispatching MCP and serves only POST /mcp', async context => {
    const port = await availablePort();
    let calls = 0;
    const server = new AgentMcpServer(async () => {
        calls++;
        return { content: [{ type: 'text', text: 'fixture-device' }] };
    }, unexpectedManual);
    context.after(() => server.stop());
    const settings = { enabled: true, port, token: 'test-token' };
    await server.start(settings);
    for (const headers of [{ Origin: 'https://example.com' }, { Host: `localhost:${port}` }]) {
        const forbidden = await httpRequest({ port, headers, body: toolCall });
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.headers['www-authenticate'], undefined);
    }
    const missing = await httpRequest({ port, headers: { Authorization: '' }, body: toolCall });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers['www-authenticate'], 'Bearer');
    const wrong = await httpRequest({ port, token: 'wrong', body: toolCall });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers['www-authenticate'], 'Bearer error="invalid_token"');
    assert.equal((await httpRequest({ port, path: '/other', body: toolCall })).status, 404);
    assert.equal((await httpRequest({ port, method: 'GET' })).status, 405);
    assert.equal(calls, 0);
    const response = await httpRequest({ port, body: toolCall });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text).result.content, [{ type: 'text', text: 'fixture-device' }]);
    assert.equal(calls, 1);
    await server.stop();
    await server.stop();
    await assert.rejects(httpRequest({ port }));
});

test('HTTP tool errors are clear and access is rejected when disabled', async context => {
    const port = await availablePort();
    const server = new AgentMcpServer(async () => { throw new Error('Agent window is unavailable.'); }, unexpectedManual);
    context.after(() => server.stop());
    await server.start({ enabled: false, port, token: 'test-token' });
    assert.equal((await httpRequest({ port, body: toolCall })).status, 403);
    await server.stop();
    await server.start({ enabled: true, port, token: 'test-token' });
    const response = await httpRequest({ port, body: toolCall });
    const result = JSON.parse(response.text) as { result: McpToolReply };
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /Agent window is unavailable/);
});

test('the SDK advertises all tools and forwards validated lookup arguments', async context => {
    const port = await availablePort();
    const server = new AgentMcpServer(async call => ({ content: [{ type: 'text', text: JSON.stringify(call) }] }), unexpectedManual);
    context.after(() => server.stop());
    await server.start({ port, token: 'test-token', enabled: true });
    const listed = await httpRequest({ port, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const tools = JSON.parse(listed.text).result.tools as { name: string; description: string }[];
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
        'create_macro', 'delete_macro', 'get_device_info', 'get_layer', 'get_macro', 'get_macro_errors', 'get_unsaved_changes',
        'list_keymaps', 'list_macros', 'rename_macro', 'set_key_action', 'update_macro',
    ]);
    assert.match(tools.find(tool => tool.name === 'get_unsaved_changes').description, /keymap.*added or removed/i);
    const macroTool = tools.find(tool => tool.name === 'get_macro');
    assert.ok(macroTool);
    assert.match(macroTool.description, /text typed by `write`.*visible/i);
    assert.match(macroTool.description, /OLED.*about 24 characters.*no scrolling/i);
    assert.match(macroTool.description, /raw values.*\$battery\.chargeLimit.*1 or 0/i);
    assert.match(macroTool.description, /`notify`.*if\/else.*wrong text.*UltimateHackingKeyboard\/firmware#1668/i);
    const params = { name: 'get_layer', arguments: { keymap: 'Unsaved', layer: 'fn' } };
    const called = await httpRequest({ port, body: { ...toolCall, params } });
    const { result } = JSON.parse(called.text) as { result: McpToolReply };
    assert.deepEqual(JSON.parse(result.content[0].text), params);
});

test('set_key_action is advertised as a write and forwards numeric key IDs and the action object', async context => {
    const port = await availablePort();
    const server = new AgentMcpServer(async call => ({ content: [{ type: 'text', text: JSON.stringify(call) }] }), unexpectedManual);
    context.after(() => server.stop());
    await server.start({ port, token: 'test-token', enabled: true });
    const listed = await httpRequest({ port, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const tool = (JSON.parse(listed.text).result.tools as { name: string; description: string; annotations: Record<string, boolean> }[])
        .find(item => item.name === 'set_key_action');
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.match(tool.description, /nothing is written to the keyboard/i);
    for (const action of [{ keyActionType: 'keystroke', type: 'basic', scancode: 4 }, 'none']) {
        const params = { name: 'set_key_action', arguments: { keymap: 'QWR', layer: 'base', moduleId: 0, keyId: 27, action } };
        const called = await httpRequest({ port, body: { ...toolCall, params } });
        const { result } = JSON.parse(called.text) as { result: McpToolReply };
        assert.deepEqual(JSON.parse(result.content[0].text), params);
    }
    const params = { name: 'set_key_action', arguments: { keymap: 'QWR', layer: 'base', moduleId: 0, keyId: 'x', action: 'none' } };
    const rejected = await httpRequest({ port, body: { ...toolCall, params } });
    assert.equal((JSON.parse(rejected.text) as { result: McpToolReply }).result.isError, true);
});

test('macro writes advertise their schemas and forward valid arguments to the renderer', async context => {
    const port = await availablePort();
    const server = new AgentMcpServer(async call => ({ content: [{ type: 'text', text: JSON.stringify(call) }] }), unexpectedManual);
    context.after(() => server.stop());
    await server.start({ port, token: 'test-token', enabled: true });
    const listed = await httpRequest({ port, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const tools = JSON.parse(listed.text).result.tools as { name: string; annotations: Record<string, boolean> }[];
    const macroActions = [{ macroActionType: 'delay', delay: 20 }];
    for (const params of [
        { name: 'create_macro', arguments: { name: 'Example', macroActions } },
        { name: 'update_macro', arguments: { name: 'Example', isPrivate: true } },
        { name: 'rename_macro', arguments: { name: 'Example', newName: 'Renamed' } },
        { name: 'delete_macro', arguments: { name: 'Renamed' } },
    ]) {
        const tool = tools.find(item => item.name === params.name);
        assert.ok(tool, params.name);
        assert.equal(tool.annotations.readOnlyHint, false);
        assert.equal(tool.annotations.destructiveHint, params.name !== 'create_macro');
        const called = await httpRequest({ port, body: { ...toolCall, params } });
        const { result } = JSON.parse(called.text) as { result: McpToolReply };
        assert.deepEqual(JSON.parse(result.content[0].text), params);
    }

    for (const params of [
        { name: 'create_macro', arguments: { name: 1, macroActions } },
        { name: 'create_macro', arguments: { macroActions } },
        { name: 'create_macro', arguments: { name: 'Example' } },
        { name: 'create_macro', arguments: { name: 'Example', macroActions: 'invalid' } },
        { name: 'create_macro', arguments: { name: 'Example', macroActions: ['invalid'] } },
        { name: 'update_macro', arguments: { name: 'Example', isLooped: 'true' } },
        { name: 'update_macro', arguments: { name: 'Example', isPrivate: 1 } },
        { name: 'update_macro', arguments: { isPrivate: true } },
        { name: 'update_macro', arguments: { name: 1, isPrivate: true } },
        { name: 'rename_macro', arguments: { name: 1, newName: 'Renamed' } },
        { name: 'rename_macro', arguments: { name: 'Example', newName: 1 } },
        { name: 'rename_macro', arguments: { newName: 'Renamed' } },
        { name: 'rename_macro', arguments: { name: 'Example' } },
        { name: 'delete_macro', arguments: { name: 1 } },
        { name: 'delete_macro', arguments: {} },
    ]) {
        const rejected = await httpRequest({ port, body: { ...toolCall, params } });
        assert.equal((JSON.parse(rejected.text) as { result: McpToolReply }).result.isError, true, JSON.stringify(params));
    }
});
