const MASKED_TOKEN = '••••••••••••••••';

/**
 * The Claude Code command that connects to Agent's MCP server. Pass masked to show it on screen
 * without the access token; copy the unmasked command.
 */
export function claudeCodeConnectCommand(port: number, token: string, masked: boolean): string {
    const shownToken = masked ? MASKED_TOKEN : token;

    return `claude mcp add --transport http uhk-agent http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${shownToken}"`;
}
