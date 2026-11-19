// The package entry point uses extensionless ESM exports, which Node cannot load in tests.
import { IO } from 'naive-autocompletion-parser/dist/cli/io.js';
import { IOProvider } from 'naive-autocompletion-parser/dist/cli/io_provider.js';
import { buildUhkParser } from 'naive-autocompletion-parser/dist/presets/uhk_preset.js';
import type { Parser } from 'naive-autocompletion-parser';

const CORE_COMMANDS = ['notify', 'set', 'if', 'goTo'];
const COMMAND_NAME = /^[a-zA-Z_]\w*$/;
const LABEL = /^\S+:(?:\s+|$)/;
const PREFIX_RULES = new Set(['CONDITION', 'MODIFIER']);
const parserIo = new class extends IO {
    override write(): void {}
    override debug(): void {}
}(IO.dummy.config, IOProvider.dummy);

export interface FirmwareCommands {
    names: ReadonlySet<string>;
    firstUnlistedCommand(source: string): string;
}

// The name list is also useful on its own, including when checking a new manual format against a fixture.
export function extractCommandNames(manual: string): ReadonlySet<string> {
    return readFirmwareCommands(manual).names;
}

export function readFirmwareCommands(manual: string): FirmwareCommands {
    try {
        // Completion stops at DEPRECATED. Include those still-supported commands and stop at REMOVED.
        const supportedCommands = manual.replace(/^# DEPRECATED #([\s\S]*?)^# REMOVED #/m, '$1# DEPRECATED #');
        // The firmware accepts bare booleans and permits a secondary-role strategy and a same-half option together.
        const grammar = supportedCommands
            .replace(/^([ \t]*CONDITION = if) \(EXPRESSION\)$/m, '$1 BOOL')
            .replace(/^([ \t]*COMMAND = while) \(EXPRESSION\) COMMAND$/m, '$1 BOOL COMMAND')
            .replace(/^([ \t]*CONDITION = \{ifPrimary \| ifSecondary\} \[[^\r\n]*\])$/m, '$1*');
        const parser = buildUhkParser(grammar, parserIo);
        const starts = parser.complete('', 'COMMAND').filter(({ suggestion }) => COMMAND_NAME.test(suggestion));
        const names = new Set(starts.map(({ suggestion }) => suggestion));
        if (CORE_COMMANDS.every(name => names.has(name))) {
            const prefixes = new Set(starts.filter(({ originRule, suggestion }) => PREFIX_RULES.has(originRule) || suggestion === 'while')
                .map(({ suggestion }) => suggestion));
            const commandGrammar = { parser, names, prefixes };
            const firstUnlistedCommand = (source: string): string => {
                for (const line of source.split('\n')) {
                    const unlisted = unlistedCommandInLine(line, commandGrammar);
                    if (unlisted) {
                        return unlisted;
                    }
                }
                return '';
            };
            return { names, firstUnlistedCommand };
        }
    } catch {
        // The manual's grammar may be incompatible with this version of the completion library.
    }
    return { names: new Set(), firstUnlistedCommand: () => '' };
}

function unlistedCommandInLine(line: string, grammar: {
    parser: Parser;
    names: ReadonlySet<string>;
    prefixes: ReadonlySet<string>;
}): string {
    const { parser, names, prefixes } = grammar;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) {
        return '';
    }
    const statement = trimmed.replace(LABEL, '');
    const head = /^[a-zA-Z_]\w*/.exec(statement)?.[0];
    if (!head) {
        return '';
    }
    if (!names.has(head)) {
        return head;
    }
    // Only prefixes introduce another command. Probing further on an ordinary command would inspect arguments.
    if (!prefixes.has(head)) {
        return '';
    }

    // After a prefix, query completion to locate nested commands without validating their arguments.
    // Match quoted text and comments as units to avoid looking for a command inside them.
    const tokens = statement.matchAll(/\/\/.*|"(?:\\.|[^"\\])*(?:"|$)|(?<!\S)'(?=\s|$)|'[^']*'|[a-zA-Z_][\w.]*|[{}&]/g);
    tokens.next();
    for (const { 0: token, index } of tokens) {
        const name = token.split('.')[0];
        const endsCommand = '{}&'.includes(token);
        if ((!COMMAND_NAME.test(name) && !endsCommand) || !/[\s)]/.test(statement[index - 1])) {
            continue;
        }
        if (!canStartCommand(parser, statement.slice(0, index))) {
            continue;
        }
        if (endsCommand) {
            return '';
        }
        const nested = statement.slice(index);
        if (LABEL.test(nested)) {
            return unlistedCommandInLine(nested, grammar);
        }
        // A prefix may accept further arguments, for example a list of keys after ifShortcut.
        if (prefixes.has(name) || canStartCommand(parser, statement.slice(0, index + token.length))) {
            continue;
        }
        return names.has(name) ? '' : name;
    }
    return '';
}

function canStartCommand(parser: Parser, prefix: string): boolean {
    // `notify` is guaranteed by the core-command check. Probe for its completion at this position.
    return parser.complete(`${prefix.trimEnd()} notif`, 'COMMAND').some(({ suggestion, overlap }) =>
        suggestion === 'notify' && overlap === 'notif'.length);
}
