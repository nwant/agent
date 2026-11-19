import {
    KeyActionHelper, keyActionType, LayerName, macroActionType, NoneAction,
    type Keymap, type Layer, type McpToolCall, type McpToolReply, type UserConfiguration,
} from 'uhk-common';

import { diffUserConfiguration, type UserConfigurationJson } from './config-diff.js';
import { parseStatusBuffer } from '../util/status-buffer-parser.js';

export interface McpDeviceInfo {
    connected: boolean;
    model: string | null;
    firmwareVersion: string | null;
    halves: { left: boolean; right: boolean; merged: boolean };
}

interface ToolState {
    info?: McpDeviceInfo;
    config: UserConfiguration;
    statusText: string;
    /** The serializer JSON of what the keyboard has, or undefined when Agent has not read it. */
    baseline?: UserConfigurationJson;
    /** Ids of unsaved-change entries that an AI client's proposed changes touched. */
    aiTags?: readonly string[];
    keyLabel(moduleId: number, keyId: number): string;
}

/** What a write leaves behind for the renderer to apply. Kept apart from the reply, which crosses IPC. */
export interface McpWriteResult {
    config: UserConfiguration;
    aiTags: string[];
}

export type McpToolResult = McpToolReply & { next?: McpWriteResult };

class ToolError extends Error {}

const KEY_PRESS_IS_THE_TEST = 'The checks prove the configuration loads, not that it works. Save to keyboard in Agent, then press the key to verify that it works.';

function findKeymap(config: UserConfiguration, identifier: unknown): Keymap {
    const byAbbreviation = config.keymaps.find(item => item.abbreviation === identifier);
    const byName = config.keymaps.filter(item => item.name === identifier);
    if (!byAbbreviation && byName.length > 1) {
        throw new ToolError('Ambiguous keymap name. Use the abbreviation from list_keymaps.');
    }
    const keymap = byAbbreviation || byName[0];
    if (!keymap) {
        throw new ToolError('Unknown keymap. Use list_keymaps to see available names.');
    }
    return keymap;
}

function findLayer(keymap: Keymap, name: unknown): Layer {
    const layer = keymap.layers.find(item => LayerName[item.id] === name);
    if (!layer) {
        throw new ToolError('Unknown layer. Use list_keymaps to see available layers.');
    }
    return layer;
}

function requireInfo(state: ToolState): McpDeviceInfo {
    if (!state.info) {
        throw new ToolError('Agent is still loading keyboard information. Try again shortly.');
    }
    return state.info;
}

function readTool(state: ToolState, call: McpToolCall): unknown {
    if (call.name === 'get_device_info') {
        return requireInfo(state);
    }
    const { config } = state;
    switch (call.name) {
        case 'list_keymaps':
            return config.keymaps.map(({ name, abbreviation, layers }) => ({
                name, abbreviation, layers: layers.map(layer => LayerName[layer.id]),
            }));
        case 'get_layer': {
            const layer = findLayer(findKeymap(config, call.arguments?.keymap), call.arguments?.layer);
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
        case 'get_macro_errors': {
            const { statusText } = state;
            const errors = parseStatusBuffer(statusText).flatMap(({ error }) => error ? [error] : []);
            if (errors.length) {
                return { errors, statusText };
            }

            return {
                errors,
                statusText,
                summary: 'Agent has no cached macro errors. An error-free save indicates that the macro loaded. Save to keyboard in Agent if needed, then press the assigned key to verify that it works.',
            };
        }
        case 'get_unsaved_changes': {
            if (!state.baseline) {
                throw new ToolError("Agent does not know the keyboard's configuration: it has not been read yet, or Agent could not use it. Connect the keyboard, or load its configuration in Agent, and try again.");
            }
            const aiTags = new Set(state.aiTags);
            const changes = diffUserConfiguration(state.baseline, config.toJsonObject() as UserConfigurationJson).map(entry => ({
                ...entry,
                ...entry.type === 'keyAction' ? { label: state.keyLabel(entry.moduleId, entry.keyId) } : {},
                aiTagged: aiTags.has(entry.id),
            }));
            const tagged = changes.filter(entry => entry.aiTagged).length;
            return {
                summary: changes.length
                    ? `${changes.length} unsaved ${changes.length === 1 ? 'change' : 'changes'}, ${tagged} AI-tagged. Save to keyboard in Agent would send all of them.`
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

/**
 * Ids of the unsaved-change entries a write changed, as get_unsaved_changes reports them: an edit inside a keymap
 * that the keyboard doesn't have belongs to that keymap's single entry.
 */
function changedIds(state: ToolState, after: UserConfiguration): string[] {
    const written = diffUserConfiguration(state.config.toJsonObject() as UserConfigurationJson, after.toJsonObject() as UserConfigurationJson);
    const onKeyboard = state.baseline && new Set(state.baseline.keymaps.map(keymap => keymap.abbreviation));
    return written.map(entry => entry.type === 'keyAction' && onKeyboard && !onKeyboard.has(entry.keymap)
        ? `keymap:${entry.keymap}`
        : entry.id);
}

function requireKeyboard(state: ToolState): void {
    if (!requireInfo(state).connected) {
        throw new ToolError('No keyboard is connected. Connect the keyboard to Agent and try again.');
    }
}

function setKeyAction(state: ToolState, args: Record<string, unknown> = {}): { value: unknown; next: McpWriteResult } {
    requireKeyboard(state);
    const { config } = state;
    const next = config.clone();
    const keymap = findKeymap(next, args.keymap);
    const layer = findLayer(keymap, args.layer);
    const module = layer.modules.find(item => item.id === args.moduleId);
    if (!module) {
        throw new ToolError('Unknown module. Use get_layer to see the module and key IDs of this layer.');
    }
    const { keyId } = args;
    if (typeof keyId !== 'number' || !Number.isInteger(keyId) || keyId < 0 || keyId >= module.keyActions.length) {
        throw new ToolError('Unknown key. Use get_layer to see the module and key IDs of this layer.');
    }
    const json = args.action === 'none' ? { keyActionType: keyActionType.NoneAction } : args.action;
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new ToolError('The action must be a key action in the serializer JSON shape, as get_layer returns it, or "none".');
    }
    const action = json as Record<string, unknown>;
    if (action.keyActionType === keyActionType.PlayMacroAction) {
        const { macroIndex } = action;
        if (typeof macroIndex !== 'number' || !Number.isInteger(macroIndex) || !next.macros[macroIndex]) {
            throw new ToolError('Unknown macro index. Use list_macros: macroIndex is the position in that list, from 0.');
        }
    }
    if (action.keyActionType === keyActionType.SwitchKeymapAction
        && !next.keymaps.some(item => item.abbreviation === action.keymapAbbreviation)) {
        throw new ToolError('Unknown keymap abbreviation. Use list_keymaps to see available abbreviations.');
    }
    const layers = new Set(keymap.layers.map(item => LayerName[item.id]));
    const targetLayer = action.keyActionType === keyActionType.SwitchLayerAction ? action.layer : action.secondaryRoleAction;
    // Secondary roles also name modifiers; only layer names must exist in this keymap.
    if (typeof targetLayer === 'string' && targetLayer in LayerName && !layers.has(targetLayer)) {
        throw new ToolError(`This keymap has no ${targetLayer} layer. Use list_keymaps to see its layers.`);
    }

    const serialisationInfo = next.getSerialisationInfo();
    let keyAction;
    try {
        keyAction = KeyActionHelper.fromJSONObject(action, next.macros, serialisationInfo);
        if (typeof action.label === 'string') {
            keyAction.label = action.label;
        }
    } catch (error) {
        throw new ToolError(`The action is not a valid key action: ${error instanceof Error ? error.message : 'it could not be read'}.`);
    }
    // The serializer turns a keystroke it can't send into "none" without complaint.
    if (keyAction instanceof NoneAction && action.keyActionType !== keyActionType.NoneAction) {
        throw new ToolError('The action does nothing: a keystroke needs a scancode the keyboard can send, a modifier or a secondary role. Use "none" to clear a key.');
    }
    // Unrecognized names (a layer, a mouse action) parse to undefined and would serialize as 0.
    const parsed: Record<string, unknown> = { ...keyAction.toJsonObject(serialisationInfo, next.macros), label: keyAction.label };
    const unread = Object.keys(action).filter(field => typeof action[field] === 'string' && parsed[field] !== action[field]);
    if (unread.length) {
        throw new ToolError(`Agent did not recognize the value of ${unread.join(', ')}. Use the serializer JSON shape, as get_layer returns it.`);
    }
    module.keyActions = module.keyActions.map((item, index) => index === keyId ? keyAction : item);
    // Backstop: the checks above catch every failure known to reach here, so no test triggers this one.
    try {
        next.recalculateConfigurationLength();
    } catch (error) {
        throw new ToolError(`The configuration would not serialize, so the key was not changed: ${error instanceof Error ? error.message : 'unknown error'}.`);
    }

    const aiTags = [...new Set([...(state.aiTags ?? []), ...changedIds(state, next)])];
    return {
        value: {
            keymap: keymap.abbreviation,
            layer: LayerName[layer.id],
            moduleId: module.id,
            keyId,
            label: state.keyLabel(module.id, keyId),
            action: module.toJsonObject(serialisationInfo, next.macros).keyActions[keyId],
            errors: [],
            summary: `Key changed in Agent's unsaved changes; nothing was written to the keyboard. ${KEY_PRESS_IS_THE_TEST}`,
        },
        next: { config: next, aiTags },
    };
}

const WRITE_TOOLS: Record<string, (state: ToolState, args?: Record<string, unknown>) => { value: unknown; next: McpWriteResult }> = {
    set_key_action: setKeyAction,
};

export function handleMcpTool(state: ToolState, call: McpToolCall, revealTextMacros = false): McpToolResult {
    let result: unknown;
    let next: McpWriteResult | undefined;
    let isError = false;
    const write = WRITE_TOOLS[call.name];
    try {
        if (write) {
            ({ value: result, next } = write(state, call.arguments));
        } else {
            result = readTool(state, call);
        }
    } catch (error) {
        result = error instanceof ToolError
            ? error.message
            : write ? 'Could not change the user configuration. Nothing was changed.' : 'Could not read the user configuration.';
        isError = true;
    }
    return { isError, content: [{ type: 'text', text: serializeReply(result, revealTextMacros) }], next };
}
