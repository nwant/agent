import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain } from 'electron';
import { ConfigureMcp, DEFAULT_MCP_SETTINGS, IpcEvents, McpSettings, McpStatus } from 'uhk-common';
import { AgentMcpServer } from '../mcp/server';
import { McpRendererBridge } from '../mcp/renderer-bridge';

interface McpServiceOptions {
    getWindow: () => BrowserWindow | undefined;
    ipc: Pick<IpcMain, 'handle'> & EventEmitter;
    settings: {
        get(key: string): Promise<unknown>;
        set(key: string, value: McpSettings): Promise<void>;
    };
}

export class McpService {
    private status: McpStatus = { ...DEFAULT_MCP_SETTINGS, error: '' };
    private readonly server: AgentMcpServer;
    private pending: Promise<unknown> = Promise.resolve();

    constructor(private readonly options: McpServiceOptions) {
        const bridge = new McpRendererBridge({ getWindow: options.getWindow, ipc: options.ipc });
        this.server = new AgentMcpServer(call => bridge.request(call));
        options.ipc.handle(IpcEvents.mcp.getSettings, event => {
            this.checkSender(event);
            return this.status;
        });
        options.ipc.handle(IpcEvents.mcp.configure, (event, input: ConfigureMcp) => {
            this.checkSender(event);
            const next = this.pending.then(() => this.configure(input));
            this.pending = next.catch(() => {});
            return next;
        });
    }

    async start(): Promise<void> {
        const saved = await this.options.settings.get('mcp-settings') as Partial<McpSettings>;
        if (saved) {
            this.status.enabled = saved.enabled === true;
            if (Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535) {
                this.status.port = saved.port;
            }
            if (typeof saved.token === 'string' && /^[a-f0-9]{64}$/.test(saved.token)) {
                this.status.token = saved.token;
            }
        }
        if (!this.status.token) {
            this.status.token = randomBytes(32).toString('hex');
        }
        await this.apply();
    }

    async stop(): Promise<void> {
        await this.pending;
        await this.server.stop();
    }

    private checkSender(event: Electron.IpcMainInvokeEvent): void {
        const win = this.options.getWindow();
        if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
            throw new Error('Unknown Agent window.');
        }
    }

    private async configure(input: ConfigureMcp): Promise<McpStatus> {
        if (!input || typeof input.enabled !== 'boolean' || typeof input.regenerateToken !== 'boolean'
            || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) {
            throw new Error('Choose an AI access port between 1024 and 65535.');
        }
        // Closing connections also cuts off any in-flight call when access changes.
        await this.server.stop();
        this.status = {
            enabled: input.enabled,
            port: input.port,
            token: input.regenerateToken ? randomBytes(32).toString('hex') : this.status.token,
            error: '',
        };
        await this.apply();
        return this.status;
    }

    private async apply(): Promise<void> {
        const { enabled, port, token } = this.status;
        // Persist before listening, so the command always uses the durable credential.
        await this.options.settings.set('mcp-settings', { enabled, port, token });
        if (!enabled) {
            return;
        }
        try {
            await this.server.start(this.status);
        } catch {
            await this.server.stop();
            this.status = { ...this.status, enabled: false, error: `Could not start AI access on port ${port}. Choose another port.` };
            await this.options.settings.set('mcp-settings', { enabled: false, port, token });
        }
    }
}
