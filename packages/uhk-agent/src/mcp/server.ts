import { z } from 'zod';
import { createServer, Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpSettings, McpToolCall, McpToolReply } from 'uhk-common';
import { checkMcpAccess } from './access-gate';

export class AgentMcpServer {
    private server?: Server;
    private readonly active = new Set<McpServer>();

    constructor(private readonly request: (call: McpToolCall) => Promise<McpToolReply>) {}

    async start(settings: Pick<McpSettings, 'enabled' | 'port' | 'token'>): Promise<void> {
        this.server = createServer((req, res) => {
            const status = checkMcpAccess(req.headers, settings);
            if (status !== 200) {
                if (status === 401) {
                    const { authorization = '' } = req.headers;
                    const challenge = authorization.startsWith('Bearer ')
                        ? 'Bearer error="invalid_token"'
                        : 'Bearer';
                    res.writeHead(401, { 'WWW-Authenticate': challenge }).end('Unauthorized. Use the current token from Agent Settings.');
                } else {
                    res.writeHead(status).end('AI access denied.');
                }
                return;
            }
            if (req.url !== '/mcp') {
                res.writeHead(404).end();
                return;
            }
            if (req.method !== 'POST') {
                res.writeHead(405, { Allow: 'POST' }).end();
                return;
            }

            const mcp = new McpServer({ name: 'uhk-agent', version: '1.0.0' });
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            this.active.add(mcp);
            res.once('close', () => {
                this.active.delete(mcp);
                void mcp.close();
            });
            const registerRead = (name: string, description: string, inputSchema: Record<string, z.ZodString> = {}) => {
                mcp.registerTool(name, {
                    description,
                    inputSchema,
                    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
                }, async args => {
                    try {
                        return { ...await this.request({ name, arguments: args }) };
                    } catch (error) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: error instanceof Error ? error.message : 'Agent window is unavailable.' }],
                        };
                    }
                });
            };
            registerRead('get_device_info', 'Read the connected keyboard model, firmware version, connection state and physical halves from Agent.');
            registerRead('list_keymaps', 'List current keymap names, abbreviations and layers, including unsaved changes.');
            registerRead('get_layer', 'Read physical key labels and serialized actions. Use a keymap abbreviation or unique name and a layer from list_keymaps.', {
                keymap: z.string(), layer: z.string(),
            });
            registerRead('list_macros', 'List current macro names and their action types.');
            registerRead('get_macro', 'Read a macro by name. Text actions are hidden unless enabled in Agent. Smart macro commands, including text typed by write, are visible.', {
                name: z.string(),
            });
            registerRead('get_unsaved_changes', 'List every difference between Agent and the keyboard, including the user\'s own edits: key actions, macros and other settings. Save to keyboard in Agent would send all of them. Key actions name the macro they play instead of its index. Text actions are hidden unless enabled in Agent.');
            registerRead('get_macro_errors', 'Read cached firmware macro errors and the latest status text, including setStatus output, after saving and pressing the assigned key.');
            void (async () => {
                try {
                    await mcp.connect(transport);
                    await transport.handleRequest(req, res);
                } catch {
                    // SDK/connection backstop: the SDK normally sends its own error response.
                    // Preserve that response if headers were already written.
                    if (!res.headersSent) {
                        res.writeHead(500).end('MCP request failed.');
                    }
                    res.end();
                }
            })();
        });
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(settings.port, '127.0.0.1', () => {
                this.server.removeListener('error', reject);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) {
            return;
        }
        const server = this.server;
        this.server = undefined;
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeAllConnections();
        await Promise.allSettled([...this.active].map(mcp => mcp.close()));
        this.active.clear();
        await closed;
    }
}
