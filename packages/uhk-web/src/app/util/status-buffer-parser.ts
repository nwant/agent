import type { Macro } from 'uhk-common';
import { escapeHtml } from './escape-html.js';

interface MacroError {
    macro: string;
    action: number;
    line: number;
    column: number;
    message: string;
}

interface StatusBlock {
    lines: string[];
    error: MacroError | null;
}

export function parseStatusBuffer(statusBuffer: string): StatusBlock[] {
    if (!statusBuffer) {
        return [];
    }

    return splitToErrorBlocks(statusBuffer).map(block => {
        const lines = block.split('\n');
        return { lines, error: parseErrorHeader(lines[0]) };
    });
}

const errorLocation = /^(?:Error at |Warning at )(.*) (\d+)\/(\d+)\/(\d+):/;
const firmwareErrorLocation = new RegExp(errorLocation.source + ' ');

function parseErrorHeader(header: string): MacroError | null {
    // Firmware puts a space after the location. A token echoed in the message can end in a bare colon.
    const match = firmwareErrorLocation.exec(header) || errorLocation.exec(header);
    if (!match) {
        return null;
    }

    const [location, macro, action, line, column] = match;
    return {
        macro,
        action: Number(action),
        line: Number(line),
        column: Number(column),
        message: header.slice(location.length).trimStart(),
    };
}

export function renderStatusBuffer(macros: Macro[], statusBuffer: string): string {
    return parseStatusBuffer(statusBuffer)
        .map(block => renderStatusBlock(macros, block))
        .join('');
}

function splitToErrorBlocks(text: string): string[] {
    const errorBlocks: string[] = [];
    const lines = text.split('\n');
    let block = '';

    function addToErrorBlocks() {
        if (block) {
            errorBlocks.push(block);
        }
        block = '';
    }

    for (const line of lines) {
        if (line.startsWith('Error at ') || line.startsWith('Warning at ')) {
            addToErrorBlocks();
        }
        block += line + '\n';
    }
    addToErrorBlocks();

    return errorBlocks;
}

function renderStatusBlock(macros: Macro[], { lines, error }: StatusBlock): string {
    if (!error || lines.length < 4) {
        return escapeHtml(lines.join('\n'));
    }
    if (!error.macro) {
        return '';
    }

    const macro = macros.find(macro => macro.name === error.macro);
    const line1Result = /^(> \d* \| )(.*)/.exec(lines[1]);
    if (!macro || !line1Result) {
        return escapeHtml(lines.join('\n'));
    }

    const url = `#/macro/${macro.id}?actionIndex=${error.action - 1}&lineNr=${error.line}&columnNr=${error.column}&inlineEdit=true`;
    const newLine2 = `${escapeHtml(line1Result[1])}<a href="${url}">${escapeHtml(line1Result[2])}</a>`;
    // Keep binding-site lines and nested location-stack lines (firmware may emit more than 3).
    const extraLines = lines
        .slice(3)
        .map(line => escapeHtml(line))
        .join('\n');

    return `${escapeHtml(lines[0])}\n${newLine2}\n${escapeHtml(lines[2])}\n${extraLines}`;
}
