import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MCP_SETTINGS } from 'uhk-common';
import { checkMcpAccess } from './access-gate';

const settings = { enabled: true, port: 53417, token: 'test-token' };
const request = { host: '127.0.0.1:53417', authorization: 'Bearer test-token' };

test('AI access is off by default', () => {
    assert.equal(checkMcpAccess(request, DEFAULT_MCP_SETTINGS), 403);
});

test('missing or wrong bearer tokens are rejected', () => {
    for (const authorization of [undefined, '', 'Bearer wrong', 'Bearer test-tokem', 'Bearer test-tokén', 'Basic test-token']) {
        assert.equal(checkMcpAccess({ ...request, authorization }, settings), 401);
    }
    assert.equal(checkMcpAccess({ ...request, authorization: 'Bearer ' }, { ...settings, token: '' }), 401);
});

test('web origins and unexpected hosts are rejected', () => {
    for (const origin of ['https://example.com', 'null', '']) {
        assert.equal(checkMcpAccess({ ...request, origin }, settings), 403);
    }
    for (const host of [undefined, 'localhost:53417', '127.0.0.1:80', 'evil.example:53417', '[::1]:53417']) {
        assert.equal(checkMcpAccess({ ...request, host }, settings), 403);
    }
});

test('a correct request is accepted and regenerating the token revokes the old credential', () => {
    assert.equal(checkMcpAccess(request, settings), 200);
    const regenerated = { ...settings, token: 'replacement-token' };
    assert.equal(checkMcpAccess(request, regenerated), 401);
    assert.equal(checkMcpAccess({ ...request, authorization: 'Bearer replacement-token' }, regenerated), 200);
});
