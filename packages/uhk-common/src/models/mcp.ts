export interface McpSettings {
    enabled: boolean;
    port: number;
    token: string;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
    enabled: false,
    port: 53417,
    token: '',
};

export interface ConfigureMcp {
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
    id: string;
    call: McpToolCall;
}

export interface McpToolResponse {
    id: string;
    reply: McpToolReply;
}
