import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain } from 'electron';
import { ConfigureMcp, DEFAULT_MCP_SETTINGS, IpcEvents, isMcpPort, LogService, MCP_MAX_PORT, MCP_MIN_PORT, McpSettings, McpStatus } from 'uhk-common';
import { AgentMcpServer } from '../mcp/server';
import { McpRendererBridge } from '../mcp/renderer-bridge';
import { MainServiceBase } from './main-service-base';

const MCP_SETTINGS_KEY = 'mcp-settings';

function generateMcpToken(): string {
    return randomBytes(32).toString('hex');
}

interface McpServiceOptions {
    ipc: Pick<IpcMain, 'handle'> & EventEmitter;
    readReferenceManual: () => Promise<string>;
    settings: {
        get(key: string): Promise<unknown>;
        set(key: string, value: McpSettings): Promise<void>;
    };
}

export class McpService extends MainServiceBase {
    private status: McpStatus = { ...DEFAULT_MCP_SETTINGS, error: '' };
    private readonly server: AgentMcpServer;
    private pending: Promise<unknown> = Promise.resolve();

    constructor(logService: LogService, win: BrowserWindow, private readonly options: McpServiceOptions) {
        super(logService, win);
        const bridge = new McpRendererBridge({ getWindow: () => this.win, ipc: options.ipc });
        this.server = new AgentMcpServer(call => bridge.request(call, this.status.revealTextMacros), options.readReferenceManual);
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
        this.logService.misc('[McpService] Loading AI access settings');
        try {
            const saved = await this.options.settings.get(MCP_SETTINGS_KEY) as Partial<McpSettings>;
            if (saved) {
                this.status.enabled = saved.enabled === true;
                this.status.revealTextMacros = saved.revealTextMacros === true;
                if (isMcpPort(saved.port)) {
                    this.status.port = saved.port;
                }
                if (typeof saved.token === 'string' && /^[a-f0-9]{64}$/.test(saved.token)) {
                    this.status.token = saved.token;
                }
            }
            if (!this.status.token) {
                this.status.token = generateMcpToken();
            }
            await this.apply();
        } catch (error) {
            this.logService.error('[McpService] Could not initialize AI access', error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        await this.pending;
        await this.server.stop();
    }

    private checkSender(event: Electron.IpcMainInvokeEvent): void {
        const win = this.win;
        if (win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
            throw new Error('Unknown Agent window.');
        }
    }

    private async configure(input: ConfigureMcp): Promise<McpStatus> {
        if (!input || typeof input.enabled !== 'boolean' || typeof input.regenerateToken !== 'boolean'
            || !isMcpPort(input.port)) {
            throw new Error(`Choose an AI access port between ${MCP_MIN_PORT} and ${MCP_MAX_PORT}.`);
        }
        // Closing connections also cuts off any in-flight call when access changes.
        await this.server.stop();
        this.status = {
            enabled: input.enabled,
            revealTextMacros: input.revealTextMacros === true,
            port: input.port,
            token: input.regenerateToken ? generateMcpToken() : this.status.token,
            error: '',
        };
        await this.apply();
        return this.status;
    }

    private async apply(): Promise<void> {
        const { enabled, port, token, revealTextMacros } = this.status;
        // Persist before listening, so the command always uses the durable credential.
        await this.options.settings.set(MCP_SETTINGS_KEY, { enabled, port, token, revealTextMacros });
        if (!enabled) {
            return;
        }
        try {
            await this.server.start(this.status);
            this.logService.misc(`[McpService] Listening on 127.0.0.1:${port}`);
        } catch (error) {
            this.logService.error(`[McpService] Could not bind to 127.0.0.1:${port}`, error);
            await this.server.stop();
            this.status = { ...this.status, enabled: false, error: `Could not start AI access on port ${port}. Choose another port.` };
            await this.options.settings.set(MCP_SETTINGS_KEY, { enabled: false, port, token, revealTextMacros });
        }
    }
}
