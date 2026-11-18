import { LayerName, macroActionType, type McpToolCall, type McpToolReply, type UserConfiguration } from 'uhk-common';

import { diffUserConfiguration, type UserConfigurationJson } from './config-diff.js';

export interface McpDeviceInfo {
    connected: boolean;
    model: string | null;
    firmwareVersion: string | null;
    halves: { left: boolean; right: boolean; merged: boolean };
}

interface ToolState {
    info?: McpDeviceInfo;
    config: UserConfiguration;
    /** The serializer JSON of what the keyboard has, or undefined when Agent has not read it. */
    baseline?: UserConfigurationJson;
    keyLabel(moduleId: number, keyId: number): string;
}

class ToolError extends Error {}

function readTool(state: ToolState, call: McpToolCall): unknown {
    if (call.name === 'get_device_info') {
        if (!state.info) {
            throw new ToolError('Agent is still loading keyboard information. Try again shortly.');
        }
        return state.info;
    }
    const { config } = state;
    switch (call.name) {
        case 'list_keymaps':
            return config.keymaps.map(({ name, abbreviation, layers }) => ({
                name, abbreviation, layers: layers.map(layer => LayerName[layer.id]),
            }));
        case 'get_layer': {
            const identifier = call.arguments?.keymap;
            const byAbbreviation = config.keymaps.find(item => item.abbreviation === identifier);
            const byName = config.keymaps.filter(item => item.name === identifier);
            if (!byAbbreviation && byName.length > 1) {
                throw new ToolError('Ambiguous keymap name. Use the abbreviation from list_keymaps.');
            }
            const keymap = byAbbreviation || byName[0];
            if (!keymap) {
                throw new ToolError('Unknown keymap. Use list_keymaps to see available names.');
            }
            const layer = keymap.layers.find(item => LayerName[item.id] === call.arguments?.layer);
            if (!layer) {
                throw new ToolError('Unknown layer. Use list_keymaps to see available layers.');
            }
            const serialisationInfo = config.getSerialisationInfo();
            const keys = layer.modules.flatMap(module => {
                const actions: unknown[] = module.toJsonObject(serialisationInfo, config.macros).keyActions;
                return actions.map((action, keyId) => ({
                    moduleId: module.id, keyId, label: state.keyLabel(module.id, keyId), action,
                }));
            });
            return { keys };
        }
        case 'list_macros':
            return config.macros.map(macro => ({
                name: macro.name,
                actionTypes: macro.macroActions.map(action => action.toJsonObject().macroActionType),
            }));
        case 'get_macro': {
            const macro = config.macros.find(item => item.name === call.arguments?.name);
            if (!macro) {
                throw new ToolError('Unknown macro. Use list_macros to see available names.');
            }
            return macro.toJsonObject();
        }
        case 'get_unsaved_changes': {
            if (!state.baseline) {
                throw new ToolError("Agent does not know the keyboard's configuration: it has not been read yet, or Agent could not use it. Connect the keyboard, or load its configuration in Agent, and try again.");
            }
            const changes = diffUserConfiguration(state.baseline, config.toJsonObject() as UserConfigurationJson).map(entry => entry.type === 'keyAction'
                ? { ...entry, label: state.keyLabel(entry.moduleId, entry.keyId) }
                : entry);
            return {
                summary: changes.length
                    ? `${changes.length} unsaved ${changes.length === 1 ? 'change' : 'changes'}. Save to keyboard in Agent would send all of them.`
                    : 'No unsaved changes. Agent matches the keyboard.',
                changes,
            };
        }
        default:
            throw new ToolError('Unknown tool.');
    }
}

function serializeReply(value: unknown, revealTextMacros: boolean): string {
    if (typeof value === 'string') {
        return value;
    }
    return JSON.stringify(value, function (key, field: unknown) {
        if (!revealTextMacros && key === 'text' && this.macroActionType === macroActionType.TextMacroAction) {
            const length = typeof field === 'string' ? Array.from(field).length : 0;
            return `[text macro, ${length} characters, hidden]`;
        }
        return field;
    });
}

export function handleMcpTool(state: ToolState, call: McpToolCall, revealTextMacros = false): McpToolReply {
    let result: unknown;
    let isError = false;
    try {
        result = readTool(state, call);
    } catch (error) {
        result = error instanceof ToolError ? error.message : 'Could not read the user configuration.';
        isError = true;
    }
    return { isError, content: [{ type: 'text', text: serializeReply(result, revealTextMacros) }] };
}
