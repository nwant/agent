import {
    CommandMacroAction, Keymap, KeyActionHelper, MCP_SETTINGS_GROUP_NAMES, keyActionType, LayerName, Macro, MacroActionHelper, macroActionType,
    MAX_ALLOWED_MACROS, MAX_ALLOWED_MACROS_TOOLTIP, NoneAction, SwitchKeymapAction,
    type FirmwareRepoInfo, type McpSettingsGroupName, type Layer, type MacroAction, type McpToolCall, type McpToolReply, type UserConfiguration,
} from 'uhk-common';

import type { ConfigDiffEntry, UserConfigurationJson } from './config-diff.js';
import type { FirmwareCommands } from './firmware-commands.js';
import { diffUserConfigurationWithRiskFlags, getTaggedUnsavedChanges } from './risk-flags.js';
import { hostConnectionsForAi, readSettings, type HostConnectionJson, type SettingsDevice } from './settings.js';
import { proposeSettingsUpdate, SettingsValidationError } from './update-settings.js';
import { generateMacroId, insertItemInNameOrder } from '../util/configuration-items.js';
import { findKeyAssignments, findMacroKeyAssignments, type MacroKeyAssignment } from '../util/find-macro-key-assignments.js';
import { parseStatusBuffer } from '../util/status-buffer-parser.js';
import { isValidName, KEYMAP_ABBREVIATION_SYMBOLS, keymapAbbreviationPattern } from '../util/validators.js';

export interface McpDeviceInfo {
    connected: boolean;
    model: string | null;
    firmwareVersion: string | null;
    halves: { left: boolean; right: boolean; merged: boolean };
}

interface ToolState {
    info?: McpDeviceInfo;
    /** The connected device's product id, for settings that only some models have. */
    deviceId?: number;
    /** Whether the keyboard display can show the extra characters keymap abbreviations may use. */
    extraLedCharacters?: boolean;
    firmware?: FirmwareRepoInfo;
    commandManual?: Required<FirmwareRepoInfo> & { commands: FirmwareCommands };
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
    /** A keymap whose abbreviation the write changed, so Agent's screen can follow it. */
    renamedKeymap?: { from: string; to: string };
}

export type McpToolResult = McpToolReply & { next?: McpWriteResult };

class ToolError extends Error {
    constructor(message: string, readonly details?: Record<string, unknown>) {
        super(message);
    }
}

const KEY_PRESS_IS_THE_TEST = 'The checks prove the configuration loads, not that it works. Save to keyboard in Agent, then press the key to verify that it works.';
const AFTER_A_VALID_PROPOSAL = 'Once a proposal passes the checks, they only establish that the configuration loads. Save to keyboard in Agent, then press the key to verify that it works.';

const SETTINGS_SAVE_NOTE = 'Review the proposed settings in Agent, then use Save to keyboard to apply them.';

interface WriteResult {
    value: unknown;
    next: McpWriteResult;
}

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

function findMacro(config: UserConfiguration, name: unknown, requireUnique = false): Macro {
    const macros = config.macros.filter(item => item.name === name);
    if (!macros.length) {
        throw new ToolError('Unknown macro. Use list_macros to see available names.');
    }
    if (requireUnique && macros.length > 1) {
        throw new ToolError('More than one macro has that name. Give them unique names in Agent first.');
    }
    return macros[0];
}

/** Names the macro a play-macro action plays, so a client need not match macroIndex against list_macros. */
function withMacroName(config: UserConfiguration, action: Record<string, unknown>): Record<string, unknown> {
    if (action.keyActionType !== keyActionType.PlayMacroAction) {
        return action;
    }
    return { ...action, macroName: config.macros[action.macroIndex as number]?.name ?? null };
}

function requireInfo(state: ToolState): McpDeviceInfo {
    if (!state.info) {
        throw new ToolError('Agent is still loading keyboard information. Try again shortly.');
    }
    return state.info;
}

function settingsDevice(state: ToolState): SettingsDevice {
    const info = requireInfo(state);
    return info.connected ? { connected: true, deviceId: state.deviceId, model: info.model } : { connected: false };
}

function requireSettingsGroup(group: unknown): McpSettingsGroupName {
    const name = MCP_SETTINGS_GROUP_NAMES.find(name => name === group);
    if (!name) {
        const supplied = typeof group === 'string' ? ` ${JSON.stringify(group)}` : '';
        throw new ToolError(`Unknown settings group${supplied}. Use one of: ${MCP_SETTINGS_GROUP_NAMES.join(', ')}.`);
    }
    return name;
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
                const actions: Array<Record<string, unknown>> = module.toJsonObject(serialisationInfo, config.macros).keyActions;
                return actions.map((action, keyId) => ({
                    moduleId: module.id, keyId, label: state.keyLabel(module.id, keyId), action: withMacroName(config, action),
                }));
            });
            return { keys };
        }
        case 'list_macros':
            return config.macros.map(macro => ({
                name: macro.name,
                actionTypes: macro.macroActions.map(action => action.toJsonObject().macroActionType),
            }));
        case 'get_macro':
            return findMacro(config, call.arguments?.name).toJsonObject();
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
        case 'get_settings': {
            const device = settingsDevice(state);
            const group = call.arguments?.group;
            return readSettings(config.toJsonObject(), device, group === undefined ? undefined : requireSettingsGroup(group));
        }
        case 'get_unsaved_changes': {
            if (!state.baseline) {
                throw new ToolError("Agent does not know the keyboard's configuration: it has not been read yet, or Agent could not use it. Connect the keyboard, or load its configuration in Agent, and try again.");
            }
            const changes = getTaggedUnsavedChanges(state.baseline, config.toJsonObject(), state.aiTags || []).map(entry => ({
                ...entry,
                ...entry.type === 'keyAction' ? { label: state.keyLabel(entry.moduleId, entry.keyId) } : {},
                ...entry.type === 'other' && entry.path === 'hostConnections' ? {
                    before: hostConnectionsForAi(entry.before as HostConnectionJson[]),
                    after: hostConnectionsForAi(entry.after as HostConnectionJson[]),
                } : {},
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
 * that the keyboard doesn't have, to a key or to the keymap's details, belongs to that keymap's single entry.
 */
function changedIds(written: ConfigDiffEntry[], baseline: ToolState['baseline']): string[] {
    const onKeyboard = baseline && new Set(baseline.keymaps.map(keymap => keymap.abbreviation));
    return written.map(entry => {
        const keymap = entry.type === 'keyAction' ? entry.keymap
            : entry.type === 'other' && entry.path.startsWith('keymaps.') ? entry.path.slice('keymaps.'.length)
                : undefined;
        return keymap !== undefined && onKeyboard && !onKeyboard.has(keymap) ? `keymap:${keymap}` : entry.id;
    });
}

function requireKeyboard(state: ToolState): void {
    if (!requireInfo(state).connected) {
        throw new ToolError('No keyboard is connected. Connect the keyboard to Agent and try again.');
    }
}

function finishWrite(state: ToolState, config: UserConfiguration, { value, summary, commandCheckNotice = '', verification = KEY_PRESS_IS_THE_TEST }: {
    value: Record<string, unknown>;
    summary: string;
    commandCheckNotice?: string;
    verification?: string;
}): WriteResult {
    try {
        config.recalculateConfigurationLength();
    } catch {
        throw new ToolError('The configuration would not serialize, so nothing was changed.');
    }
    const written = diffUserConfigurationWithRiskFlags(
        state.config.toJsonObject(), config.toJsonObject());
    const aiTags = [...new Set([...(state.aiTags ?? []), ...changedIds(written, state.baseline)])];
    return {
        value: {
            ...value,
            errors: [],
            riskFlags: [...new Set(written.flatMap(entry => entry.riskFlags))],
            summary: `${summary} in Agent's unsaved changes; nothing was written to the keyboard. ${commandCheckNotice}${verification}`,
        },
        next: { config, aiTags },
    };
}

function setKeyAction(state: ToolState, args: Record<string, unknown>): WriteResult {
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
    const supplied = json as Record<string, unknown>;
    const { macroName, ...withoutMacroName } = supplied;
    const action = supplied.keyActionType === keyActionType.PlayMacroAction ? withoutMacroName : supplied;
    if (action.keyActionType === keyActionType.PlayMacroAction) {
        const { macroIndex } = action;
        if (typeof macroIndex !== 'number' || !Number.isInteger(macroIndex) || !next.macros[macroIndex]) {
            throw new ToolError('Unknown macro index. Use list_macros: macroIndex is the position in that list, from 0.');
        }
        // get_layer adds macroName; a stale one means the client's macro list is out of date.
        if (macroName !== undefined && macroName !== next.macros[macroIndex].name) {
            throw new ToolError('macroName does not match macroIndex. Use list_macros: macroIndex is the position in that list, from 0.');
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
    return finishWrite(state, next, {
        value: {
            keymap: keymap.abbreviation,
            layer: LayerName[layer.id],
            moduleId: module.id,
            keyId,
            label: state.keyLabel(module.id, keyId),
            action: module.toJsonObject(serialisationInfo, next.macros).keyActions[keyId],
        },
        summary: 'Key changed',
    });
}

/** A trimmed, non-empty name that no other macro or keymap in items has. */
function availableName<T extends { name: string }>(items: T[], noun: 'macro' | 'keymap', name: unknown, except?: T): string {
    if (typeof name !== 'string' || !isValidName(name)) {
        throw new ToolError(`A non-empty ${noun} name is required.`);
    }
    const trimmed = name.trim();
    if (items.some(item => item !== except && item.name === trimmed)) {
        throw new ToolError(`A ${noun} with that name already exists. Use a unique name.`);
    }
    return trimmed;
}

const NUMERIC_MACRO_ACTION_FIELDS = new Set(['delay', 'modifierMask', 'mouseButtonsMask', 'scancode', 'x', 'y']);

function parseMacroActions(config: UserConfiguration, macroActions: unknown): MacroAction[] {
    if (!Array.isArray(macroActions)) {
        throw new ToolError('macroActions must be an array of macro actions in the serializer JSON shape, as get_macro returns it.');
    }
    const serialisationInfo = config.getSerialisationInfo();
    return macroActions.map((supplied: Record<string, unknown>, index) => {
        try {
            const action = MacroActionHelper.fromJSONObject(supplied, serialisationInfo);
            const parsed: Record<string, unknown> = action.toJsonObject();
            // Check types and round-trip values since binary serialization coerces some invalid inputs.
            const validFields = Object.entries(parsed).every(([field, value]) => NUMERIC_MACRO_ACTION_FIELDS.has(field)
                ? Number.isInteger(value)
                : typeof value === 'string');
            if (validFields && Object.entries(supplied).every(([field, value]) => parsed[field] === value)) {
                return action;
            }
        } catch {
            // Serializer errors can include the supplied action contents.
        }
        throw new ToolError(`Invalid macro action at position ${index + 1}. Use the serializer JSON shape, as get_macro returns it.`);
    });
}

function setMacroFlags(macro: Macro, { isLooped, isPrivate }: Record<string, unknown>): void {
    if ((isLooped !== undefined && typeof isLooped !== 'boolean') || (isPrivate !== undefined && typeof isPrivate !== 'boolean')) {
        throw new ToolError('isLooped and isPrivate must be booleans.');
    }
    if (typeof isLooped === 'boolean') {
        macro.isLooped = isLooped;
    }
    if (typeof isPrivate === 'boolean') {
        macro.isPrivate = isPrivate;
    }
}

function checkMacroCommands(state: ToolState, actions: MacroAction[]): string {
    const commandActions = actions.filter(action => action instanceof CommandMacroAction);
    if (!commandActions.length) {
        return '';
    }
    const { firmware, commandManual } = state;
    if (!commandManual?.commands.names.size || commandManual.firmwareGitRepo !== firmware?.firmwareGitRepo
        || commandManual.firmwareGitTag !== firmware?.firmwareGitTag) {
        return 'Smart-macro command name check skipped: no usable reference manual is available for the connected firmware. ';
    }
    for (const { command } of commandActions) {
        const unlisted = commandManual.commands.firstUnlistedCommand(command);
        if (unlisted) {
            throw new ToolError(`The command "${unlisted}" is not in the reference manual for the connected firmware (${commandManual.firmwareGitRepo} ${commandManual.firmwareGitTag}).`);
        }
    }
    return '';
}

function createMacro(state: ToolState, args: Record<string, unknown>): WriteResult {
    const next = state.config.clone();
    if (next.macros.length >= MAX_ALLOWED_MACROS) {
        throw new ToolError(MAX_ALLOWED_MACROS_TOOLTIP);
    }
    const macro = new Macro();
    macro.name = availableName(next.macros, 'macro', args.name);
    macro.isLooped = false;
    macro.isPrivate = false;
    setMacroFlags(macro, args);
    macro.macroActions = parseMacroActions(next, args.macroActions);
    const commandCheckNotice = checkMacroCommands(state, macro.macroActions);
    macro.id = generateMacroId(next.macros);
    next.macros = insertItemInNameOrder(next.macros, macro);
    return finishWrite(state, next, { value: { macro: macro.toJsonObject() }, summary: 'Macro created', commandCheckNotice });
}

function updateMacro(state: ToolState, args: Record<string, unknown>): WriteResult {
    const next = state.config.clone();
    const macro = findMacro(next, args.name, true);
    const { isLooped, isPrivate, macroActions } = args;
    if (isLooped === undefined && isPrivate === undefined && macroActions === undefined) {
        throw new ToolError('Provide macroActions, isLooped or isPrivate to update the macro.');
    }
    setMacroFlags(macro, args);
    let commandCheckNotice = '';
    if (macroActions !== undefined) {
        macro.macroActions = parseMacroActions(next, macroActions);
        commandCheckNotice = checkMacroCommands(state, macro.macroActions);
    }
    return finishWrite(state, next, { value: { macro: macro.toJsonObject() }, summary: 'Macro updated', commandCheckNotice });
}

function renameMacro(state: ToolState, args: Record<string, unknown>): WriteResult {
    const next = state.config.clone();
    const macro = findMacro(next, args.name, true);
    const name = availableName(next.macros, 'macro', args.newName, macro);
    if (name !== macro.name) {
        macro.name = name;
        next.macros = insertItemInNameOrder(next.macros, macro, item => item !== macro);
    }
    return finishWrite(state, next, { value: { macro: macro.toJsonObject() }, summary: 'Macro renamed' });
}

/** Keys that block a deletion, in the shape both delete refusals return. */
function refusedKeys(state: ToolState, assignments: MacroKeyAssignment[]): Array<Record<string, unknown>> {
    return assignments.map(({ keymapAbbreviation, layerId, moduleId, keyId }) => ({
        keymap: keymapAbbreviation,
        layer: LayerName[layerId],
        moduleId,
        keyId,
        label: state.keyLabel(moduleId, keyId),
    }));
}

function deleteMacro(state: ToolState, args: Record<string, unknown>): WriteResult {
    const { config } = state;
    const macro = findMacro(config, args.name, true);
    const keys = refusedKeys(state, findMacroKeyAssignments(config.keymaps, macro.id));
    if (keys.length) {
        throw new ToolError('The macro is still assigned to the listed keys. Clear those assignments before deleting it.', { keys });
    }
    const next = config.clone();
    next.macros = next.macros.filter(item => item.id !== macro.id);
    return finishWrite(state, next, { value: { name: macro.name, macro: null }, summary: 'Macro deleted' });
}

function keymapReply({ name, abbreviation, isDefault }: Keymap): Record<string, unknown> {
    return { keymap: { name, abbreviation, isDefault } };
}

// The keymap editor's rule, which upper-cases what it accepts. Here a lowercase letter is refused instead, so the
// abbreviation the client sends is the one keys switch to.
function availableKeymapAbbreviation(state: ToolState, config: UserConfiguration, abbreviation: unknown, except?: Keymap): string {
    const extraLedCharacters = Boolean(state.extraLedCharacters);
    const pattern = keymapAbbreviationPattern({ extraLedCharacters, lowercase: false });
    const allowed = extraLedCharacters
        ? `1 to 3 uppercase letters, digits, spaces or any of ${KEYMAP_ABBREVIATION_SYMBOLS.trim()}`
        : '1 to 3 uppercase letters or digits';
    if (typeof abbreviation !== 'string' || !abbreviation.trim() || !pattern.test(abbreviation)) {
        throw new ToolError(`The abbreviation must be ${allowed}, as the keyboard display shows it.`);
    }
    if (config.keymaps.some(keymap => keymap !== except && keymap.abbreviation === abbreviation)) {
        throw new ToolError('A keymap with that abbreviation already exists. Use list_keymaps to see the taken abbreviations.');
    }
    return abbreviation;
}

function duplicateKeymap(state: ToolState, args: Record<string, unknown>): WriteResult {
    const next = state.config.clone();
    const source = findKeymap(next, args.keymap);
    const info = next.getSerialisationInfo();
    // A serializer round trip, so no layer, module or key action is shared with the source.
    const copy = new Keymap().fromJsonObject(source.toJsonObject(info, next.macros), next.macros, info);
    copy.name = availableName(next.keymaps, 'keymap', args.name);
    copy.abbreviation = availableKeymapAbbreviation(state, next, args.abbreviation);
    copy.isDefault = false;
    next.keymaps = insertItemInNameOrder(next.keymaps, copy);
    return finishWrite(state, next, { value: keymapReply(copy), summary: 'Keymap duplicated' });
}

function renameKeymap(state: ToolState, args: Record<string, unknown>): WriteResult {
    const next = state.config.clone();
    const keymap = findKeymap(next, args.keymap);
    const { name, abbreviation, description } = args;
    if (name === undefined && abbreviation === undefined && description === undefined) {
        throw new ToolError('Provide name, abbreviation or description to rename the keymap.');
    }
    if (description !== undefined && typeof description !== 'string') {
        throw new ToolError('The description must be text.');
    }
    const newName = name === undefined ? keymap.name : availableName(next.keymaps, 'keymap', name, keymap);
    const newAbbreviation = abbreviation === undefined ? keymap.abbreviation : availableKeymapAbbreviation(state, next, abbreviation, keymap);
    const oldAbbreviation = keymap.abbreviation;
    Object.assign(keymap, { name: newName, abbreviation: newAbbreviation, description: description ?? keymap.description });
    if (newAbbreviation !== oldAbbreviation) {
        // Keymap switches name their target by abbreviation. Unlike the editor, this includes the keymap's own keys.
        next.keymaps = next.keymaps.map(item => item.renameKeymap(oldAbbreviation, newAbbreviation));
    }
    const renamed = next.keymaps.find(item => item.abbreviation === newAbbreviation);
    next.keymaps = insertItemInNameOrder(next.keymaps, renamed, item => item !== renamed);
    const result = finishWrite(state, next, { value: keymapReply(renamed), summary: 'Keymap renamed' });
    if (newAbbreviation !== oldAbbreviation) {
        result.next.renamedKeymap = { from: oldAbbreviation, to: newAbbreviation };
    }
    return result;
}

function deleteKeymap(state: ToolState, args: Record<string, unknown>): WriteResult {
    const { config } = state;
    const keymap = findKeymap(config, args.keymap);
    if (keymap.isDefault) {
        throw new ToolError('This is the default keymap, which the keyboard starts in. Make another keymap the default with set_default_keymap first.');
    }
    // Its own keys go with it, so only keys in other keymaps block the deletion.
    const keys = refusedKeys(state, findKeyAssignments(config.keymaps.filter(item => item !== keymap),
        action => action instanceof SwitchKeymapAction && action.keymapAbbreviation === keymap.abbreviation));
    if (keys.length) {
        throw new ToolError('Other keys switch to this keymap. Change those keys before deleting it.', { keys });
    }
    const next = config.clone();
    next.keymaps = next.keymaps.filter(item => item.abbreviation !== keymap.abbreviation);
    return finishWrite(state, next, {
        value: { name: keymap.name, abbreviation: keymap.abbreviation, keymap: null },
        summary: 'Keymap deleted',
    });
}

function setDefaultKeymap(state: ToolState, args: Record<string, unknown>): WriteResult {
    const next = state.config.clone();
    const keymap = findKeymap(next, args.keymap);
    for (const item of next.keymaps) {
        item.isDefault = item === keymap;
    }
    return finishWrite(state, next, { value: keymapReply(keymap), summary: 'Default keymap changed' });
}

function updateSettings(state: ToolState, args: Record<string, unknown>): WriteResult {
    const group = requireSettingsGroup(args.group);
    const proposed = proposeSettingsUpdate({ config: state.config, device: settingsDevice(state), group, values: args.values });
    return finishWrite(state, proposed.config, {
        value: { group, values: proposed.values },
        summary: `Proposed settings for ${group}`,
        verification: SETTINGS_SAVE_NOTE,
    });
}

const WRITE_TOOLS = new Map<string, (state: ToolState, args: Record<string, unknown>) => WriteResult>([
    ['set_key_action', setKeyAction],
    ['create_macro', createMacro],
    ['update_macro', updateMacro],
    ['rename_macro', renameMacro],
    ['delete_macro', deleteMacro],
    ['duplicate_keymap', duplicateKeymap],
    ['rename_keymap', renameKeymap],
    ['delete_keymap', deleteKeymap],
    ['set_default_keymap', setDefaultKeymap],
    ['update_settings', updateSettings],
]);

export function handleMcpTool(state: ToolState, call: McpToolCall, revealTextMacros = false): McpToolResult {
    let result: unknown;
    let next: McpWriteResult | undefined;
    let isError = false;
    const write = WRITE_TOOLS.get(call.name);
    try {
        if (write) {
            requireKeyboard(state);
            ({ value: result, next } = write(state, call.arguments ?? {}));
        } else {
            result = readTool(state, call);
        }
    } catch (error) {
        const message = error instanceof ToolError || error instanceof SettingsValidationError
            ? error.message
            : write ? 'Could not change the user configuration. Nothing was changed.' : 'Could not read the user configuration.';
        const text = write && write !== updateSettings ? `${message} ${AFTER_A_VALID_PROPOSAL}` : message;
        result = error instanceof ToolError && error.details ? { message: text, ...error.details } : text;
        isError = true;
    }
    return { isError, content: [{ type: 'text', text: serializeReply(result, revealTextMacros) }], next };
}
