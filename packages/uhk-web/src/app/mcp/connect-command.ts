const MASKED_TOKEN = '••••••••••••••••';

function shownToken(token: string, masked: boolean): string {
    return masked ? MASKED_TOKEN : token;
}

/**
 * The Claude Code command that connects to Agent's MCP server. Pass masked to show it on screen
 * without the access token; copy the unmasked command.
 */
export function claudeCodeConnectCommand(port: number, token: string, masked: boolean): string {
    return `claude mcp add --transport http uhk-agent http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${shownToken(token, masked)}"`;
}

/**
 * The Codex config.toml entry that connects to Agent's MCP server. The `codex mcp add` command only
 * reads a bearer token from an environment variable, which apps started outside a shell do not
 * see, so the header goes into the config file instead.
 */
export function codexConnectConfig(port: number, token: string, masked: boolean): string {
    return [
        '[mcp_servers.uhk-agent]',
        `url = "http://127.0.0.1:${port}/mcp"`,
        `http_headers = { Authorization = "Bearer ${shownToken(token, masked)}" }`,
    ].join('\n');
}
