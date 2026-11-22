import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { claudeCodeConnectCommand } from './connect-command.js';

describe('claudeCodeConnectCommand', () => {
    it('builds the full command with the token', () => {
        assert.equal(
            claudeCodeConnectCommand(53417, 'abc123', false),
            'claude mcp add --transport http uhk-agent http://127.0.0.1:53417/mcp --header "Authorization: Bearer abc123"',
        );
    });

    it('hides the token when masked', () => {
        const command = claudeCodeConnectCommand(53417, 'abc123', true);

        assert.ok(!command.includes('abc123'));
        assert.match(command, /^claude mcp add --transport http uhk-agent http:\/\/127\.0\.0\.1:53417\/mcp --header "Authorization: Bearer •+"$/);
    });
});
