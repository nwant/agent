import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpToolReply } from 'uhk-common';
import { AgentMcpServer } from './server';
import { availablePort, httpRequest } from './test-http';

const toolCall = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_device_info', arguments: {} } };

test('HTTP enforces access before dispatching MCP and serves only POST /mcp', async context => {
    const port = await availablePort();
    let calls = 0;
    const server = new AgentMcpServer(async () => {
        calls++;
        return { content: [{ type: 'text', text: 'fixture-device' }] };
    });
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
    const server = new AgentMcpServer(async () => { throw new Error('Agent window is unavailable.'); });
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

test('the SDK advertises all read tools and forwards validated lookup arguments', async context => {
    const port = await availablePort();
    const server = new AgentMcpServer(async call => ({ content: [{ type: 'text', text: JSON.stringify(call) }] }));
    context.after(() => server.stop());
    await server.start({ port, token: 'test-token', enabled: true });
    const listed = await httpRequest({ port, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.deepEqual(JSON.parse(listed.text).result.tools.map((tool: { name: string }) => tool.name).sort(),
        ['get_device_info', 'get_layer', 'get_macro', 'list_keymaps', 'list_macros']);
    const params = { name: 'get_layer', arguments: { keymap: 'Unsaved', layer: 'fn' } };
    const called = await httpRequest({ port, body: { ...toolCall, params } });
    assert.deepEqual(JSON.parse(JSON.parse(called.text).result.content[0].text), params);
});
