import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { EventEmitter } from 'node:events';
import { IpcEvents, McpToolCall, McpToolReply, McpToolResponse } from 'uhk-common';

export class McpRendererBridge {
    constructor(private readonly options: {
        getWindow: () => BrowserWindow | undefined;
        ipc: EventEmitter;
    }) {}

    request(call: McpToolCall, revealTextMacros = false): Promise<McpToolReply> {
        const win = this.options.getWindow();
        if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isLoadingMainFrame()) {
            return Promise.reject(new Error('Agent window is unavailable or still loading.'));
        }

        const sender = win.webContents;
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                this.options.ipc.removeListener(IpcEvents.mcp.response, receive);
                sender.removeListener('destroyed', unavailable);
                sender.removeListener('render-process-gone', unavailable);
                sender.removeListener('did-start-loading', unavailable);
            };
            const unavailable = () => {
                cleanup();
                reject(new Error('Agent window became unavailable.'));
            };
            const receive = (event: Electron.IpcMainEvent, [response]: [McpToolResponse]) => {
                if (event.sender !== sender || !response || response.id !== id) {
                    return;
                }
                cleanup();
                resolve(response.reply);
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Agent window did not reply within 10 seconds.'));
            }, 10_000);
            this.options.ipc.on(IpcEvents.mcp.response, receive);
            sender.once('destroyed', unavailable);
            sender.once('render-process-gone', unavailable);
            sender.once('did-start-loading', unavailable);
            try {
                sender.send(IpcEvents.mcp.request, { id, call, revealTextMacros });
            } catch {
                unavailable();
            }
        });
    }
}
