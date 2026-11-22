import { KeyModifiers, keyActionType, LayerName, macroActionType } from 'uhk-common';

import {
    diffUserConfiguration, type ConfigDiffEntry, type KeyActionDiffEntry, type KeyActionJson, type MacroJson, type UserConfigurationJson,
} from './config-diff.js';

const RISK_FLAGS = ['runsWithoutKeyPress', 'typesIntoHost', 'opensLauncherOrShell', 'cannotBeChecked', 'changesKeyboard', 'lockout'] as const;

export type RiskFlag = typeof RISK_FLAGS[number];

export type FlaggedConfigDiffEntry = ConfigDiffEntry & { riskFlags: RiskFlag[] };
export type UnsavedChange = FlaggedConfigDiffEntry & { aiTagged: boolean };

export function getTaggedUnsavedChanges(
    baseline: UserConfigurationJson, current: UserConfigurationJson, aiTags: readonly string[],
): UnsavedChange[] {
    const tags = new Set(aiTags);
    return diffUserConfigurationWithRiskFlags(baseline, current).map(entry => ({
        ...entry,
        aiTagged: tags.has(entry.id),
    }));
}

const EVENT_MACRO_NAME = /^\$on(?:Init|KeymapChange|LayerChange|KeymapLayerChange|CapsLockStateChange|NumLockStateChange|ScrollLockStateChange|Error|Join|Split)(?:\s|$)/;

const KEY_COMMANDS = new Map([
    ['pressKey', 'press'], ['releaseKey', 'release'], ['holdKey', 'hold'], ['tapKey', 'tap'], ['toggleKey', 'toggle'], ['tapKeySeq', 'tap'],
]);
const TEXT_COMMANDS = new Set(['write', 'writeExpr', 'printStatus']);
const MACRO_CALLS = new Set(['call', 'exec', 'fork', 'playMacro']);
const LOCKOUT_COMMANDS = new Set(['switchHost', 'unpairHost', 'resetConfiguration', 'freeze', 'panic']);
const KEYBOARD_CHANGING_COMMANDS = new Set([
    'set', 'overlayLayer', 'replaceLayer', 'overlayKeymap', 'replaceKeymap', 'powerMode', ...LOCKOUT_COMMANDS,
]);
const COMMANDS_AFTER_PREFIX = new Set([
    ...KEY_COMMANDS.keys(), ...TEXT_COMMANDS, ...MACRO_CALLS, ...KEYBOARD_CHANGING_COMMANDS,
    // Recognize these commands so their arguments are not mistaken for commands after a conditional.
    'setLedTxt', 'notify', 'resetTrackpoint', 'switchKeymap', 'switchLayer', 'switchKeymapLayer',
    'toggleLayer', 'toggleKeymapLayer', 'untoggleLayer', 'holdLayer', 'holdLayerMax', 'holdKeymapLayer',
    'holdKeymapLayerMax', 'reconnect', 'reboot', 'zephyr',
]);
const COMMAND_PREFIX = /^(?:if[A-Z]\w*|if|else|while|suppressMods|suppressKeys|postponeKeys|final|autoRepeat|oneShot)$/;
const LAUNCHER_SHORTCUTS = [
    { key: 'r', scancode: 21, modifiers: KeyModifiers.leftGui }, // Windows Run
    { key: 'space', scancode: 44, modifiers: KeyModifiers.leftGui }, // Spotlight
    { key: 'escape', scancode: 41, modifiers: KeyModifiers.leftCtrl }, // Windows Start
    { key: 'f2', scancode: 59, modifiers: KeyModifiers.leftAlt }, // Linux run dialog
    { key: 't', scancode: 23, modifiers: KeyModifiers.leftCtrl | KeyModifiers.leftAlt }, // Linux terminal
];
const SHORTCUT_MODIFIERS = new Map([
    ['C', KeyModifiers.leftCtrl], ['S', KeyModifiers.leftShift], ['A', KeyModifiers.leftAlt],
    ['G', KeyModifiers.leftGui], ['W', KeyModifiers.leftGui],
]);

function isLauncherChord(key: unknown, modifierMask: number): boolean {
    // Either side's modifier can invoke the shortcut.
    const modifiers = (modifierMask | (modifierMask >> 4)) & 0x0f;
    return LAUNCHER_SHORTCUTS.some(shortcut =>
        (shortcut.key === key || shortcut.scancode === key) && shortcut.modifiers === modifiers);
}

interface MacroKeystroke {
    key: unknown;
    modifiers: number;
    mode: unknown;
}

function readShortcut(shortcut: string, defaultMode: string): MacroKeystroke {
    const match = /^([LRCSAGWiosprth]+)(?:-(\S*))?$/.exec(shortcut);
    if (!match || shortcut.length === 1) {
        return { key: shortcut, modifiers: 0, mode: defaultMode };
    }
    const [, prefix, key = ''] = match;
    let modifiers = 0;
    let mode = defaultMode;
    let sendsToHost = true;
    let right = false;
    for (const char of prefix) {
        switch (char) {
            case 'i': sendsToHost = false; break;
            case 's':
            case 'o': sendsToHost = true; break;
            case 'L': right = false; break;
            case 'R': right = true; break;
            case 'p': mode = 'press'; break;
            case 'r': mode = 'release'; break;
            case 't': mode = 'tap'; break;
            case 'h': mode = 'hold'; break;
            default: {
                const mask = SHORTCUT_MODIFIERS.get(char);
                if (sendsToHost) {
                    modifiers |= right ? mask << 4 : mask;
                }
                right = false;
            }
        }
    }
    // Uppercase literal keys add an implicit Shift in firmware. Launcher rules match the unshifted chords.
    return { key, modifiers, mode };
}

function flagMacroKeystroke({ key, modifiers, mode }: MacroKeystroke, held: number, flags: Set<RiskFlag>): number {
    if (mode === 'release') {
        return held & ~modifiers;
    }
    flags.add('typesIntoHost');
    if (isLauncherChord(key, modifiers | held)) {
        flags.add('opensLauncherOrShell');
    }
    if (mode === 'toggle') {
        return held ^ modifiers;
    }
    return mode === 'press' ? held | modifiers : held;
}

function flagCommands(source: string, flags: Set<RiskFlag>, heldModifiers: number): number {
    for (const line of source.split('\n')) {
        // Labels and block braces can precede a command. Scan tokens outside of strings and comments.
        const tokens: string[] = line.replace(/^(?:\s|[{}]|[a-zA-Z_]\w*:)*/, '')
            .match(/"(?:\\.|[^"\\])*"|'[^']*'|\/\/|[^\s"']+/g) ?? [];
        const comment = tokens.indexOf('//');
        const words = comment < 0 ? tokens : tokens.slice(0, comment);
        const index = COMMAND_PREFIX.test(words[0])
            ? words.findIndex(word => COMMANDS_AFTER_PREFIX.has(word))
            : 0;
        const command = words[index];
        const args = words.slice(index + 1);
        const keyMode = KEY_COMMANDS.get(command);
        if (keyMode) {
            const shortcuts = args[0] === 'persistent' ? args.slice(1) : args;
            for (const shortcut of command === 'tapKeySeq' ? shortcuts : shortcuts.slice(0, 1)) {
                heldModifiers = flagMacroKeystroke(readShortcut(shortcut, keyMode), heldModifiers, flags);
            }
        }
        if (TEXT_COMMANDS.has(command)) {
            flags.add('typesIntoHost');
            // Single-quoted text is literal, but a write can concatenate multiple strings.
            if (command !== 'write' || args.some(text => /^"(?:\\.|[^"\\])*?\$[\w(]/.test(text))) {
                flags.add('cannotBeChecked');
            }
        }
        const hasDynamicArgument = args.some(word => word.startsWith('$'));
        if (hasDynamicArgument || MACRO_CALLS.has(command) || words.some(word => /^&macroArg\.\d+$/.test(word))) {
            flags.add('cannotBeChecked');
        }
        if (KEYBOARD_CHANGING_COMMANDS.has(command)) {
            flags.add('changesKeyboard');
        }
        const maySuspendInput = command === 'powerMode' && args.some(word => word === 'lock' || word === 'sleep');
        const changesRecoveryKey = command === 'set' && (args[0] === 'emergencyKey' || args[0] === 'recoveryKey');
        if (LOCKOUT_COMMANDS.has(command) || maySuspendInput || changesRecoveryKey) {
            flags.add('lockout');
        }
    }
    return heldModifiers;
}

function flagMacroActions(macro: MacroJson, flags: Set<RiskFlag>): void {
    let heldModifiers = 0;
    for (const action of macro.macroActions) {
        if (action.macroActionType === macroActionType.TextMacroAction && action.text) {
            flags.add('typesIntoHost');
        }
        if (action.macroActionType === macroActionType.KeyMacroAction) {
            heldModifiers = flagMacroKeystroke({
                key: action.type === 'basic' ? action.scancode : undefined,
                modifiers: Number(action.modifierMask) || 0,
                mode: action.action,
            }, heldModifiers, flags);
        }
        if (action.macroActionType === macroActionType.CommandMacroAction && typeof action.command === 'string') {
            heldModifiers = flagCommands(action.command, flags, heldModifiers);
        }
    }
}

function switchTarget(action: KeyActionJson): string {
    if (action?.keyActionType === keyActionType.SwitchKeymapAction) {
        return typeof action.keymapAbbreviation === 'string' ? 'keymap:' + action.keymapAbbreviation : '';
    }
    if (action?.keyActionType === keyActionType.SwitchLayerAction) {
        return typeof action.layer === 'string' ? 'layer:' + action.layer : '';
    }
    const layer = action?.secondaryRoleAction;
    return typeof layer === 'string' && typeof LayerName[layer as keyof typeof LayerName] === 'number' ? 'layer:' + layer : '';
}

function flagKeyAction(action: KeyActionJson, macros: UserConfigurationJson['macros'], flags: Set<RiskFlag>): void {
    if (action?.keyActionType === keyActionType.KeystrokeAction && action.type === 'basic'
        && isLauncherChord(action.scancode, Number(action.modifierMask) || 0)) {
        flags.add('opensLauncherOrShell');
    }
    if (action?.keyActionType === keyActionType.PlayMacroAction) {
        const assigned = typeof action.macroIndex === 'number' ? macros[action.macroIndex] : undefined;
        if (assigned) {
            flagMacroActions(assigned, flags);
        } else {
            flags.add('cannotBeChecked');
        }
    }
}

/** A switch whose target keymap changed abbreviation: the old one is gone and the new one is not on the keyboard. */
function followsKeymapRename(before: string, after: string, baseline: UserConfigurationJson, current: UserConfigurationJson): boolean {
    const keymap = (target: string) => target.startsWith('keymap:') ? target.slice('keymap:'.length) : undefined;
    const [from, to] = [keymap(before), keymap(after)];
    return from !== undefined && to !== undefined
        && !current.keymaps.some(item => item.abbreviation === from)
        && !baseline.keymaps.some(item => item.abbreviation === to);
}

function flagKeyChange(entry: KeyActionDiffEntry, baseline: UserConfigurationJson, current: UserConfigurationJson, flags: Set<RiskFlag>): void {
    const keymap = current.keymaps.find(item => item.abbreviation === entry.keymap);
    const layer = keymap.layers.find(item => item.id === entry.layer);
    const module = layer?.modules.find(item => item.id === entry.moduleId);
    // Classify the actual macro index even when legacy configurations have duplicate macro names.
    flagKeyAction(module?.keyActions[entry.keyId] ?? null, current.macros, flags);

    const before = switchTarget(entry.before);
    const after = switchTarget(entry.after);
    if (before || after) {
        flags.add('changesKeyboard');
    }
    if (before && before !== after && entry.layer === 'base' && !followsKeymapRename(before, after, baseline, current)) {
        if (!layer?.modules.some(item => item.keyActions.some(action => switchTarget(action) === before))) {
            flags.add('lockout');
        }
    }
}

function flagKeymap(entry: Extract<ConfigDiffEntry, { type: 'keymap' }>, current: UserConfigurationJson, flags: Set<RiskFlag>): void {
    flags.add('changesKeyboard');
    if (entry.change === 'added') {
        const keymap = current.keymaps.find(item => item.abbreviation === entry.abbreviation);
        for (const layer of keymap.layers) {
            for (const module of layer.modules) {
                for (const action of module.keyActions) {
                    flagKeyAction(action, current.macros, flags);
                }
            }
        }
    }
}

export function diffUserConfigurationWithRiskFlags(
    baseline: UserConfigurationJson, current: UserConfigurationJson,
): FlaggedConfigDiffEntry[] {
    return diffUserConfiguration(baseline, current).map(entry => {
        const flags = new Set<RiskFlag>();
        if (entry.type === 'macro' && entry.after) {
            if (EVENT_MACRO_NAME.test(entry.name)) {
                flags.add('runsWithoutKeyPress');
            }
            flagMacroActions(entry.after, flags);
        }
        if (entry.type === 'keyAction') {
            flagKeyChange(entry, baseline, current, flags);
        }
        if (entry.type === 'keymap') {
            flagKeymap(entry, current, flags);
        }
        if (entry.type === 'other' && changesKeyboardSetting(entry, baseline, current)) {
            flags.add('changesKeyboard');
        }
        return { ...entry, riskFlags: RISK_FLAGS.filter(flag => flags.has(flag)) };
    });
}

function changesKeyboardSetting(
    entry: Extract<ConfigDiffEntry, { type: 'other' }>, baseline: UserConfigurationJson, current: UserConfigurationJson,
): boolean {
    const keymapPath = 'keymaps.';
    if (!entry.path.startsWith(keymapPath)) {
        return true;
    }
    const abbreviation = entry.path.slice(keymapPath.length);
    const before = baseline.keymaps.find(keymap => keymap.abbreviation === abbreviation);
    const after = current.keymaps.find(keymap => keymap.abbreviation === abbreviation);
    return before.isDefault !== after.isDefault;
}
