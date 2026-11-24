import { macroActionType } from 'uhk-common';

import type { MacroJson } from './config-diff.js';

const EVENT_MACRO_NAME = /^\$on(?:Init|KeymapChange|LayerChange|KeymapLayerChange|CapsLockStateChange|NumLockStateChange|ScrollLockStateChange|Error|Join|Split)(?:\s|$)/;
const CALL_COMMANDS = new Set(['call', 'exec', 'fork']);

/** Whether the firmware runs the macro by itself, without a key press. */
export function isEventMacro(name: string): boolean {
    return EVENT_MACRO_NAME.test(name);
}

interface MacroCalls {
    names: Set<string>;
    /** Whether a call has a target that cannot be worked out from the source. */
    unknown: boolean;
}

function readCalls(macro: MacroJson): MacroCalls {
    const calls: MacroCalls = { names: new Set(), unknown: false };
    for (const action of macro.macroActions) {
        if (action.macroActionType !== macroActionType.CommandMacroAction || typeof action.command !== 'string') {
            continue;
        }
        for (const line of action.command.split('\n')) {
            // Find calls at any position rather than parse the line: a wrong guess only asks the user to save in Agent.
            const tokens: string[] = line.match(/"(?:\\.|[^"\\])*"|'[^']*'|\/\/|[^\s"'(){}]+/g) ?? [];
            const comment = tokens.indexOf('//');
            const words = (comment < 0 ? tokens : tokens.slice(0, comment)).map(word => word.replace(/^[a-zA-Z_]\w*:/, ''));
            for (const [index, word] of words.entries()) {
                if (word.startsWith('&')) {
                    // An injected argument can be a whole command.
                    calls.unknown = true;
                } else if (CALL_COMMANDS.has(word)) {
                    const target = words[index + 1];
                    if (target && !/^[$&"']/.test(target)) {
                        calls.names.add(target);
                    } else {
                        calls.unknown = true;
                    }
                }
            }
        }
    }
    return calls;
}

/** The macros that event macros start by name, directly or through other macros. */
export function findEventMacroCalls(macros: MacroJson[]): MacroCalls {
    const found: MacroCalls = { names: new Set(), unknown: false };
    const pending = macros.filter(macro => isEventMacro(macro.name));
    for (let macro = pending.pop(); macro; macro = pending.pop()) {
        const { names, unknown } = readCalls(macro);
        found.unknown ||= unknown;
        for (const name of names) {
            if (!found.names.has(name)) {
                found.names.add(name);
                pending.push(...macros.filter(item => item.name === name));
            }
        }
    }
    return found;
}
