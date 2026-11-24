import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { EventEmitter } from 'node:events';
import { IpcEvents, MCP_SAVE_TOOL, McpPermissions, McpToolCall, McpToolReply, McpToolResponse } from 'uhk-common';

const REPLY_TIMEOUT_SECONDS = 10;
// Longer than the renderer waits for the keyboard, so the renderer's own answer arrives first.
const SAVE_REPLY_TIMEOUT_SECONDS = 75;

export class McpRendererBridge {
    constructor(private readonly options: {
        getWindow: () => BrowserWindow | undefined;
        ipc: EventEmitter;
    }) {}

    request(call: McpToolCall, { revealTextMacros, allowSave }: McpPermissions = { revealTextMacros: false, allowSave: false }): Promise<McpToolReply> {
        const win = this.options.getWindow();
        if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isLoadingMainFrame()) {
            return Promise.reject(new Error('Agent window is unavailable or still loading.'));
        }

        const sender = win.webContents;
        const id = randomUUID();
        const isSave = call.name === MCP_SAVE_TOOL;
        const timeoutSeconds = isSave ? SAVE_REPLY_TIMEOUT_SECONDS : REPLY_TIMEOUT_SECONDS;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                this.options.ipc.removeListener(IpcEvents.mcp.response, receive);
                sender.removeListener('destroyed', unavailable);
                sender.removeListener('render-process-gone', unavailable);
                sender.removeListener('did-start-loading', unavailable);
            };
            const noReply = (message: string) => {
                cleanup();
                if (isSave) {
                    // The renderer has the request, so the keyboard may have been written.
                    const text = JSON.stringify({ result: 'unknown', message: `${message} The save may or may not have reached the keyboard.` });
                    resolve({ isError: true, content: [{ type: 'text', text }] });
                } else {
                    reject(new Error(message));
                }
            };
            const unavailable = () => noReply('Agent window became unavailable.');
            const receive = (event: Electron.IpcMainEvent, [response]: [McpToolResponse]) => {
                if (event.sender !== sender || !response || response.id !== id) {
                    return;
                }
                cleanup();
                resolve(response.reply);
            };
            const timer = setTimeout(() => noReply(`Agent window did not reply within ${timeoutSeconds} seconds.`), timeoutSeconds * 1000);
            this.options.ipc.on(IpcEvents.mcp.response, receive);
            sender.once('destroyed', unavailable);
            sender.once('render-process-gone', unavailable);
            sender.once('did-start-loading', unavailable);
            try {
                sender.send(IpcEvents.mcp.request, { id, call, revealTextMacros, allowSave });
            } catch {
                unavailable();
            }
        });
    }
}
