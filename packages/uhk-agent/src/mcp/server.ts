import { createServer, Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpSettings, McpToolCall, McpToolReply } from 'uhk-common';
import { checkMcpAccess } from './access-gate';

export class AgentMcpServer {
    private server?: Server;
    private readonly active = new Set<McpServer>();

    constructor(private readonly request: (call: McpToolCall) => Promise<McpToolReply>) {}

    async start(settings: McpSettings): Promise<void> {
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
            mcp.registerTool('get_device_info', {
                description: 'Read the connected keyboard model, firmware version, connection state and physical halves from Agent.',
                inputSchema: {},
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            }, async () => {
                try {
                    return { ...await this.request({ name: 'get_device_info' }) };
                } catch (error) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: error instanceof Error ? error.message : 'Agent window is unavailable.' }],
                    };
                }
            });
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
