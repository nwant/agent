import { Injectable, inject } from '@angular/core';
import { createSelector, Store } from '@ngrx/store';
import { take } from 'rxjs/operators';
import { ConfigureMcp, IpcEvents, MCP_MAX_PORT, MCP_MIN_PORT, McpStatus, McpToolRequest } from 'uhk-common';
import { McpRendererService } from '../../app/services/mcp-renderer.service';
import { IpcCommonRenderer } from '../../app/services/ipc-common-renderer';
import {
    AppState, getAiTags, getConnectedDevice, getMcpDeviceInfo, getUserConfiguration, getDefaultUserConfiguration, getKeyboardBaseline,
    getLatestStatusBuffer, getRightModuleFirmwareRepoInfo, smartMacroDocState,
} from '../../app/store';
import { ApplyAiUserConfigurationAction } from '../../app/store/actions/user-config';
import { MapperService } from '../../app/services/mapper.service';
import { getDefaultQwertyKeyLabel } from '../../app/util/get-default-key-label';
import { handleMcpTool } from '../../app/mcp/tool-handler';
import { readFirmwareCommands } from '../../app/mcp/firmware-commands';

const getReferenceManual = createSelector(smartMacroDocState, state => state.referenceManual);
const getCommandManual = createSelector(getReferenceManual, manual => {
    if (manual) {
        const { firmwareGitRepo, firmwareGitTag, text } = manual;
        return { firmwareGitRepo, firmwareGitTag, commands: readFirmwareCommands(text) };
    }
    return undefined;
});

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
                const { next, ...reply } = handleMcpTool({
                    info: getMcpDeviceInfo(state),
                    deviceId: getConnectedDevice(state)?.id,
                    firmware: getRightModuleFirmwareRepoInfo(state),
                    get commandManual() { return getCommandManual(state); },
                    config: getUserConfiguration(state),
                    baseline: getKeyboardBaseline(state),
                    statusText: getLatestStatusBuffer(state),
                    aiTags: getAiTags(state),
                    keyLabel: (moduleId, keyId) => getDefaultQwertyKeyLabel({
                        defaultUserConfiguration: getDefaultUserConfiguration(state), moduleId, keyId, mapper: this.mapper,
                    }),
                }, request.call, request.revealTextMacros);
                if (next) {
                    this.store.dispatch(new ApplyAiUserConfigurationAction({ userConfiguration: next.config, aiTags: next.aiTags }));
                }
                this.ipcRenderer.send(IpcEvents.mcp.response, { id: request.id, reply });
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
