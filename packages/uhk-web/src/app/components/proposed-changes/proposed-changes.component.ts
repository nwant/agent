import { AsyncPipe, JsonPipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { createSelector, Store } from '@ngrx/store';
import { take } from 'rxjs';
import { KeystrokeType, LayerName, macroActionType, ModuleId, UHK_MODULES, type UserConfiguration } from 'uhk-common';

import type { KeyActionJson, MacroJson, OtherDiffEntry } from '../../mcp/config-diff';
import { RISK_FLAG_LABELS } from '../../mcp/risk-flag-labels';
import { settingsPage } from '../../mcp/settings';
import type { UnsavedChange } from '../../mcp/risk-flags';
import { MapperService } from '../../services/mapper.service';
import {
    AppState, deviceState, getDefaultUserConfiguration, getMcpDeviceInfo, getUnsavedChanges, getUserConfiguration,
    isUserConfigLoading, isUserConfigSaving,
} from '../../store';
import { LoadConfigFromDeviceAction } from '../../store/actions/user-config';
import { LAYER_OPTIONS } from '../../store/reducers/layer-options';
import { getDefaultQwertyKeyLabel } from '../../util/get-default-key-label';

interface ChangeLocation {
    title: string;
    route?: string[];
    query?: { layer: LayerName; module?: number; key?: number };
    relatedLinks?: Array<{ label: string; route: string[] }>;
}

const canDiscardUnsavedChanges = createSelector(
    getMcpDeviceInfo, isUserConfigLoading, isUserConfigSaving, deviceState,
    (info, loading, saving, device) => Boolean(info?.connected) && !loading && !saving && !device.modifiedConfigWhileSaved,
);

@Component({
    selector: 'proposed-changes',
    imports: [AsyncPipe, JsonPipe, RouterLink, TitleCasePipe],
    templateUrl: './proposed-changes.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { class: 'container-fluid full-screen-component pb-5' },
})
export class ProposedChangesComponent {
    private readonly store = inject<Store<AppState>>(Store);
    private readonly mapper = inject(MapperService);

    readonly riskLabels = RISK_FLAG_LABELS;
    readonly loading$ = this.store.select(isUserConfigLoading);
    readonly canDiscard$ = this.store.select(canDiscardUnsavedChanges);

    readonly review$ = this.store.select(createSelector(
        getUnsavedChanges, getUserConfiguration, getDefaultUserConfiguration,
        (changes, config, defaultConfig) => {
            if (!changes) {
                return undefined;
            }
            return {
                entries: changes.map(change => ({
                    change,
                    ...this.locateChange(change, config, defaultConfig),
                })),
                aiCount: changes.filter(change => change.aiTagged).length,
            };
        },
    ));

    discard(): void {
        this.canDiscard$.pipe(take(1)).subscribe(canDiscard => {
            if (canDiscard) {
                this.store.dispatch(new LoadConfigFromDeviceAction());
            }
        });
    }

    actionDetails(action: KeyActionJson): KeyActionJson {
        if (action && typeof action.scancode === 'number') {
            const type = action.type === 'media' ? KeystrokeType.longMedia
                : action.type === 'system' ? KeystrokeType.system : KeystrokeType.basic;
            return { ...action, key: this.mapper.scanCodeToText(action.scancode, type).join(' ') };
        }
        return action;
    }

    macroActionText(action: MacroJson['macroActions'][number]): string {
        if (action.macroActionType === macroActionType.TextMacroAction && typeof action.text === 'string') {
            return action.text;
        }
        if (action.macroActionType === macroActionType.CommandMacroAction && typeof action.command === 'string') {
            return action.command;
        }
        return JSON.stringify(action, null, 2);
    }

    private locateChange(change: UnsavedChange, config: UserConfiguration, defaultUserConfiguration: UserConfiguration): ChangeLocation {
        switch (change.type) {
            case 'keyAction': {
                const keymap = config.keymaps.find(keymap => keymap.abbreviation === change.keymap);
                const layer = LayerName[change.layer as keyof typeof LayerName];
                const label = getDefaultQwertyKeyLabel({
                    defaultUserConfiguration, moduleId: change.moduleId, keyId: change.keyId, mapper: this.mapper,
                });
                const title = `${keymap.name} › ${LAYER_OPTIONS.get(layer).name} › ${label}`;
                const route = ['/keymap', keymap.abbreviation];
                if (!keymap.layers.some(item => item.id === layer)) {
                    return { title, route };
                }
                const query = change.after
                    ? { layer, module: change.moduleId, key: change.keyId }
                    : { layer };
                return { title, route, query };
            }
            case 'keymap':
                return {
                    title: change.name,
                    ...(change.change === 'removed'
                        ? { relatedLinks: [{ label: 'Open keymaps', route: ['/keymap'] }] }
                        : { route: ['/keymap', change.abbreviation] }),
                };
            case 'macro': {
                const macro = config.macros.find(macro => macro.name === change.name);
                return {
                    title: change.name,
                    ...(macro
                        ? { route: ['/macro', String(macro.id)] }
                        : { relatedLinks: [{ label: 'Open macros', route: ['/macro'] }] }),
                };
            }
            case 'other':
                return this.locateSetting(change, config);
        }
    }

    private locateSetting(change: OtherDiffEntry, config: UserConfiguration): ChangeLocation {
        const { path, before, after } = change;
        if (path.startsWith('keymaps.')) {
            const abbreviation = path.slice('keymaps.'.length);
            const keymap = config.keymaps.find(keymap => keymap.abbreviation === abbreviation);
            return { title: keymap.name, route: ['/keymap', abbreviation] };
        }

        const title = path.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, first => first.toUpperCase());
        if (path === 'moduleConfigurations' && Array.isArray(before) && Array.isArray(after)) {
            const changedModules = UHK_MODULES.filter(({ id, configPath }) => {
                const name = ModuleId[id];
                return configPath && JSON.stringify(before.find(module => module.id === name))
                    !== JSON.stringify(after.find(module => module.id === name));
            });
            if (changedModules.length) {
                return {
                    title,
                    relatedLinks: changedModules.map(module => ({ label: module.name, route: [module.configPath] })),
                };
            }
        }
        return { title, route: ['/device', settingsPage(path)] };
    }
}
