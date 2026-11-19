export type KeyActionJson = Record<string, unknown> | null;

export interface MacroJson {
    name: string;
    macroActions: Array<Record<string, unknown>>;
}

/** The parts of the serializer's JSON shape (UserConfiguration.toJsonObject()) that the diff walks. */
export interface UserConfigurationJson {
    keymaps: Array<{
        abbreviation: string;
        name: string;
        isDefault: boolean;
        layers: Array<{
            id: string;
            modules: Array<{ id: number; keyActions: KeyActionJson[] }>;
        }>;
    }>;
    macros: MacroJson[];
    [setting: string]: unknown;
}

type KeymapJson = UserConfigurationJson['keymaps'][number];

export interface KeyActionDiffEntry {
    id: string;
    type: 'keyAction';
    keymap: string;
    layer: string;
    moduleId: number;
    keyId: number;
    before: KeyActionJson;
    after: KeyActionJson;
}

export interface KeymapDiffEntry {
    id: string;
    type: 'keymap';
    change: 'added' | 'removed';
    abbreviation: string;
    name: string;
}

export interface MacroDiffEntry {
    id: string;
    type: 'macro';
    name: string;
    change: 'added' | 'changed' | 'removed';
    before: MacroJson | null;
    after: MacroJson | null;
}

export interface OtherDiffEntry {
    id: string;
    type: 'other';
    path: string;
    before: unknown;
    after: unknown;
}

export type ConfigDiffEntry = KeyActionDiffEntry | KeymapDiffEntry | MacroDiffEntry | OtherDiffEntry;

// Version and last-save tags are stamped by Agent and firmware, not edited by the user.
const SAVE_METADATA = new Set([
    'userConfigMajorVersion', 'userConfigMinorVersion', 'userConfigPatchVersion', 'lastSaveAgentTag', 'lastSaveFirmwareTag',
]);

const same = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second);

// Macro indexes point into each side's own macro list, so compare and report the macro name instead.
function resolveMacro(action: KeyActionJson, macros: MacroJson[]): KeyActionJson {
    if (!action || typeof action.macroIndex !== 'number') {
        return action;
    }
    const { macroIndex, ...rest } = action;
    return { ...rest, macroName: macros[macroIndex]?.name ?? null };
}

interface KeyAt {
    layer: string;
    moduleId: number;
    keyId: number;
    action: KeyActionJson;
}

function keyActions(keymap: KeymapJson, macros: UserConfigurationJson['macros']): Map<string, KeyAt> {
    const keys = new Map<string, KeyAt>();
    for (const layer of keymap.layers) {
        for (const module of layer.modules) {
            module.keyActions.forEach((action, keyId) => {
                keys.set(`${layer.id}/${module.id}/${keyId}`, {
                    layer: layer.id, moduleId: module.id, keyId, action: resolveMacro(action, macros),
                });
            });
        }
    }
    return keys;
}

function keymapDetails(keymap: KeymapJson): unknown {
    const { layers, ...details } = keymap;
    return details;
}

function diffKeymaps(baseline: UserConfigurationJson, current: UserConfigurationJson): ConfigDiffEntry[] {
    const entries: ConfigDiffEntry[] = [];
    const abbreviations = new Set([...baseline.keymaps, ...current.keymaps].map(keymap => keymap.abbreviation));
    for (const abbreviation of abbreviations) {
        const beforeKeymap = baseline.keymaps.find(keymap => keymap.abbreviation === abbreviation);
        const afterKeymap = current.keymaps.find(keymap => keymap.abbreviation === abbreviation);
        // A keymap on one side only is one entry; its keys are not listed.
        if (!beforeKeymap || !afterKeymap) {
            const { name } = beforeKeymap ?? afterKeymap;
            entries.push({ id: `keymap:${abbreviation}`, type: 'keymap', change: beforeKeymap ? 'removed' : 'added', abbreviation, name });
            continue;
        }
        const [beforeDetails, afterDetails] = [keymapDetails(beforeKeymap), keymapDetails(afterKeymap)];
        if (!same(beforeDetails, afterDetails)) {
            const path = `keymaps.${abbreviation}`;
            entries.push({ id: `other:${path}`, type: 'other', path, before: beforeDetails, after: afterDetails });
        }
        const before = keyActions(beforeKeymap, baseline.macros);
        const after = keyActions(afterKeymap, current.macros);
        for (const key of new Set([...before.keys(), ...after.keys()])) {
            const { layer, moduleId, keyId } = before.get(key) ?? after.get(key);
            const beforeAction = before.get(key)?.action ?? null;
            const afterAction = after.get(key)?.action ?? null;
            if (!same(beforeAction, afterAction)) {
                entries.push({
                    id: `key:${abbreviation}/${key}`,
                    type: 'keyAction',
                    keymap: abbreviation,
                    layer, moduleId, keyId,
                    before: beforeAction,
                    after: afterAction,
                });
            }
        }
    }
    return entries;
}

// Macros have no stable id in the serializer shape, so a rename shows as a removal and an addition.
function diffMacros(baseline: UserConfigurationJson, current: UserConfigurationJson): ConfigDiffEntry[] {
    const entries: ConfigDiffEntry[] = [];
    const names = new Set([...baseline.macros, ...current.macros].map(macro => macro.name));
    for (const name of names) {
        const before = baseline.macros.find(macro => macro.name === name) ?? null;
        const after = current.macros.find(macro => macro.name === name) ?? null;
        if (!same(before, after)) {
            const change = !before ? 'added' : !after ? 'removed' : 'changed';
            entries.push({ id: `macro:${name}`, type: 'macro', name, change, before, after });
        }
    }
    return entries;
}

function diffSettings(baseline: UserConfigurationJson, current: UserConfigurationJson): ConfigDiffEntry[] {
    const entries: ConfigDiffEntry[] = [];
    for (const path of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
        if (path === 'keymaps' || path === 'macros' || SAVE_METADATA.has(path)) {
            continue;
        }
        const before = baseline[path] ?? null;
        const after = current[path] ?? null;
        if (!same(before, after)) {
            entries.push({ id: `other:${path}`, type: 'other', path, before, after });
        }
    }
    return entries;
}

/**
 * Diffs the current user configuration against the keyboard baseline, both in the serializer's JSON shape.
 * Each entry's id is stable across calls, for AI tags.
 */
export function diffUserConfiguration(baseline: UserConfigurationJson, current: UserConfigurationJson): ConfigDiffEntry[] {
    return [...diffKeymaps(baseline, current), ...diffMacros(baseline, current), ...diffSettings(baseline, current)];
}

export function pruneAiTags(tags: string[], baseline: UserConfigurationJson | undefined, current: UserConfigurationJson): string[] {
    if (!tags.length || !baseline) {
        return tags;
    }
    const changedIds = new Set(diffUserConfiguration(baseline, current).map(entry => entry.id));
    const remaining = tags.filter(id => changedIds.has(id));
    return remaining.length === tags.length ? tags : remaining;
}
