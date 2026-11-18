import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { take } from 'rxjs/operators';
import { ConfigureMcp, IpcEvents, MCP_MAX_PORT, MCP_MIN_PORT, McpStatus, McpToolRequest } from 'uhk-common';
import { McpRendererService } from '../../app/services/mcp-renderer.service';
import { IpcCommonRenderer } from '../../app/services/ipc-common-renderer';
import { AppState, getMcpDeviceInfo, getUserConfiguration, getDefaultUserConfiguration, getKeyboardBaseline } from '../../app/store';
import { MapperService } from '../../app/services/mapper.service';
import { getDefaultQwertyKeyLabel } from '../../app/util/get-default-key-label';
import { handleMcpTool } from '../../app/mcp/tool-handler';

@Injectable()
export class ElectronMcpRendererService extends McpRendererService {
    private readonly store = inject<Store<AppState>>(Store);
    private readonly ipcRenderer = inject(IpcCommonRenderer);
    private readonly mapper = inject(MapperService);
    private readonly loaded: Promise<void>;

    constructor() {
        super();
        this.ipcRenderer.on(IpcEvents.mcp.request, (_event: unknown, request: McpToolRequest) => {
            this.store.pipe(take(1)).subscribe(state => {
                this.ipcRenderer.send(IpcEvents.mcp.response, {
                    id: request.id,
                    reply: handleMcpTool({
                        info: getMcpDeviceInfo(state),
                        config: getUserConfiguration(state),
                        baseline: getKeyboardBaseline(state),
                        keyLabel: (moduleId, keyId) => getDefaultQwertyKeyLabel({
                            defaultUserConfiguration: getDefaultUserConfiguration(state), moduleId, keyId, mapper: this.mapper,
                        }),
                    }, request.call, request.revealTextMacros),
                });
            });
        });
        this.loaded = this.load();
    }

    override async configure(changes: Partial<ConfigureMcp>): Promise<void> {
        await this.loaded;
        const { enabled, port, revealTextMacros } = this.status.value;
        const input: ConfigureMcp = { enabled, port, revealTextMacros, regenerateToken: false, ...changes };
        try {
            this.status.next(await this.ipcRenderer.invoke<McpStatus>(IpcEvents.mcp.configure, input));
        } catch {
            this.status.next({
                ...this.status.value,
                error: `Could not update AI access. Choose a port between ${MCP_MIN_PORT} and ${MCP_MAX_PORT}, or restart Agent.`,
            });
        }
    }

    private async load(): Promise<void> {
        try {
            this.status.next(await this.ipcRenderer.invoke<McpStatus>(IpcEvents.mcp.getSettings));
        } catch {
            this.status.next({ ...this.status.value, error: 'Could not load AI access settings. Restart Agent.' });
        }
    }
}
