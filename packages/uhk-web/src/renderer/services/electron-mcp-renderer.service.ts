import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { take } from 'rxjs/operators';
import { ConfigureMcp, IpcEvents, McpStatus, McpToolRequest } from 'uhk-common';
import { McpRendererService } from '../../app/services/mcp-renderer.service';
import { IpcCommonRenderer } from '../../app/services/ipc-common-renderer';
import { AppState, getMcpDeviceInfo } from '../../app/store';
import { handleMcpTool } from '../../app/mcp/tool-handler';

interface McpIpc {
    invoke(channel: string, ...args: unknown[]): Promise<McpStatus>;
}

@Injectable()
export class ElectronMcpRendererService extends McpRendererService {
    private readonly store = inject<Store<AppState>>(Store);
    private readonly ipcRenderer = inject(IpcCommonRenderer);
    private readonly ipc = (window as unknown as { electron: { ipcRenderer: McpIpc } }).electron.ipcRenderer;

    constructor() {
        super();
        this.ipcRenderer.on(IpcEvents.mcp.request, (_event: unknown, request: McpToolRequest) => {
            this.store.select(getMcpDeviceInfo).pipe(take(1)).subscribe(info => {
                this.ipcRenderer.send(IpcEvents.mcp.response, {
                    id: request.id,
                    reply: handleMcpTool(info, request.call),
                });
            });
        });
        void this.load();
    }

    override async configure(input: ConfigureMcp): Promise<void> {
        try {
            this.status.next(await this.ipc.invoke(IpcEvents.mcp.configure, input));
        } catch {
            this.status.next({ ...this.status.value, error: 'Could not update AI access. Choose a port between 1024 and 65535, or restart Agent.' });
        }
    }

    private async load(): Promise<void> {
        try {
            this.status.next(await this.ipc.invoke(IpcEvents.mcp.getSettings));
        } catch {
            this.status.next({ ...this.status.value, error: 'Could not load AI access settings. Restart Agent.' });
        }
    }
}
