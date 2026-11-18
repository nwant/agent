import type { McpToolCall, McpToolReply } from 'uhk-common';

export interface McpDeviceInfo {
    connected: boolean;
    model: string | null;
    firmwareVersion: string | null;
    halves: { left: boolean; right: boolean; merged: boolean };
}

export function handleMcpTool(info: McpDeviceInfo | undefined, call: McpToolCall): McpToolReply {
    if (call.name !== 'get_device_info') {
        return { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] };
    }
    if (!info) {
        return { isError: true, content: [{ type: 'text', text: 'Agent is still loading keyboard information. Try again shortly.' }] };
    }

    return { content: [{ type: 'text', text: JSON.stringify(info) }] };
}
