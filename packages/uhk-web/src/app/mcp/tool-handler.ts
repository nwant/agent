import type { McpToolCall, McpToolReply } from 'uhk-common';

export interface McpDeviceInfo {
    connected: boolean;
    model: string | null;
    firmwareVersion: string | null;
    halves: { left: boolean; right: boolean; merged: boolean };
}

export interface McpDeviceInput extends McpDeviceInfo {
    communicationAvailable: boolean;
    hasPermission: boolean;
    bootloaderActive: boolean;
}

export function handleMcpTool(device: McpDeviceInput, call: McpToolCall): McpToolReply {
    if (call.name !== 'get_device_info') {
        return { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] };
    }

    const connected = device.connected && device.communicationAvailable && device.hasPermission && !device.bootloaderActive;
    const info: McpDeviceInfo = {
        connected,
        model: connected ? device.model : null,
        firmwareVersion: connected ? device.firmwareVersion : null,
        halves: {
            left: connected && device.halves.left,
            right: connected && device.halves.right,
            merged: connected && device.halves.merged,
        },
    };
    return { content: [{ type: 'text', text: JSON.stringify(info) }] };
}
