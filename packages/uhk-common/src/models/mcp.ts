export interface McpSettings {
    revealTextMacros: boolean;
    enabled: boolean;
    port: number;
    token: string;
}

export const MCP_MIN_PORT = 1024;
export const MCP_MAX_PORT = 65535;

export function isMcpPort(port: unknown): port is number {
    return typeof port === 'number' && Number.isInteger(port) && port >= MCP_MIN_PORT && port <= MCP_MAX_PORT;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
    enabled: false,
    revealTextMacros: false,
    port: 53417,
    token: '',
};

export interface ConfigureMcp {
    revealTextMacros: boolean;
    enabled: boolean;
    port: number;
    regenerateToken: boolean;
}

export interface McpStatus extends McpSettings {
    error: string;
}

export interface McpToolCall {
    name: string;
    arguments?: Record<string, unknown>;
}

export interface McpToolReply {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

export interface McpToolRequest {
    revealTextMacros: boolean;
    id: string;
    call: McpToolCall;
}

export interface McpToolResponse {
    id: string;
    reply: McpToolReply;
}
