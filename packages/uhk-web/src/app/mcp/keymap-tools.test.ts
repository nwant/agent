import { UHK_80_USER_CONFIG, UserConfiguration } from 'uhk-common';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserConfigurationJson } from './config-diff.js';
import { handleMcpTool, type McpDeviceInfo } from './tool-handler.js';

const connected: McpDeviceInfo = { connected: true, model: 'UHK 80', firmwareVersion: '18.0.5', halves: { left: true, right: true, merged: true } };
const keyLabel = (moduleId: number, keyId: number) => `${moduleId}/${keyId}`;

type Json = UserConfigurationJson & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type State = Partial<Parameters<typeof handleMcpTool>[0]>;

function baseKeys(json: Json, abbreviation = 'QWR', layer = 'base', moduleId = 0): unknown[] {
    return json.keymaps.find(keymap => keymap.abbreviation === abbreviation).layers
        .find(item => item.id === layer).modules.find(module => module.id === moduleId).keyActions;
}

function fixture(edit: (json: Json) => void = () => undefined) {
    const json = structuredClone(UHK_80_USER_CONFIG) as unknown as Json;
    edit(json);
    const config = new UserConfiguration().fromJsonObject(json);
    const baseline = config.toJsonObject() as UserConfigurationJson;
    const state = { keyLabel, statusText: '', config, baseline, info: connected };
    const call = (name: string, args: Record<string, unknown> = {}, extra: State = {}) => {
        const input = { ...state, ...extra };
        const before = JSON.stringify(input.config.toJsonObject());
        const result = handleMcpTool(input, { name, arguments: args });
        assert.equal(JSON.stringify(input.config.toJsonObject()), before, 'the input configuration is not mutated');
        const text = result.content[0].text;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { result, text, body: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as any };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsaved = (next: State) => call('get_unsaved_changes', {}, next).body.changes as any[];
    const jsonOf = (next: State) => next.config.toJsonObject() as Json;
    return { state, call, unsaved, jsonOf };
}

test('get_layer names the macro a play-macro key plays next to its index', () => {
    const { call } = fixture(json => {
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 1, macroArguments: [] };
    });
    const { keys } = call('get_layer', { keymap: 'QWR', layer: 'base' }).body;
    const key = keys.find(({ moduleId, keyId }) => moduleId === 0 && keyId === 27);
    assert.equal(key.action.macroIndex, 1);
    assert.equal(key.action.macroName, 'God mode in Doom');
    assert.equal(keys.filter(({ action }) => 'macroName' in action).length, 1);
});

test('set_key_action accepts a play-macro key as get_layer returns it and refuses a macroName that is not at macroIndex', () => {
    const { call } = fixture(json => {
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 1, macroArguments: [] };
    });
    const { action } = call('get_layer', { keymap: 'QWR', layer: 'base' }).body.keys.find(({ moduleId, keyId }) => moduleId === 0 && keyId === 27);
    const args = { keymap: 'QWR', layer: 'base', moduleId: 0, keyId: 28 };
    const accepted = call('set_key_action', { ...args, action });
    assert.equal(accepted.result.isError, false, accepted.text);
    assert.equal(accepted.body.action.macroIndex, 1);
    const refused = call('set_key_action', { ...args, action: { ...action, macroName: 'Go to UHK site in browser' } });
    assert.equal(refused.result.isError, true);
    assert.match(refused.text, /macroName does not match macroIndex/);
    const keystroke = call('set_key_action', { ...args, action: { keyActionType: 'keystroke', type: 'basic', scancode: 4, macroName: 'x' } });
    assert.match(keystroke.text, /did not recognize the value of macroName/);
});

function assertWriteReply(reply: unknown) {
    const body = reply as { errors: unknown[]; summary: string; riskFlags: unknown[] };
    assert.deepEqual(body.errors, []);
    assert.ok(Array.isArray(body.riskFlags));
    assert.match(body.summary, /nothing was written to the keyboard/);
    assert.match(body.summary, /save to keyboard/i);
}

test('set_default_keymap moves the default flag, flags a keyboard change and tags both keymaps', () => {
    const { call, unsaved, jsonOf } = fixture();
    const { result, body, text } = call('set_default_keymap', { keymap: 'Colemak for PC' });
    assert.equal(result.isError, false, text);
    assertWriteReply(body);
    assert.deepEqual(body.keymap, { name: 'Colemak for PC', abbreviation: 'COL', isDefault: true });
    assert.deepEqual(body.riskFlags, ['changesKeyboard']);
    assert.deepEqual(jsonOf(result.next).keymaps.filter(keymap => keymap.isDefault).map(keymap => keymap.abbreviation), ['COL']);
    assert.deepEqual(unsaved(result.next).map(({ id, aiTagged, riskFlags }) => ({ id, aiTagged, riskFlags })), [
        { id: 'other:keymaps.COL', aiTagged: true, riskFlags: ['changesKeyboard'] },
        { id: 'other:keymaps.QWR', aiTagged: true, riskFlags: ['changesKeyboard'] },
    ]);

    const again = call('set_default_keymap', { keymap: 'QWR' });
    assert.equal(again.result.isError, false);
    assert.deepEqual(unsaved(again.result.next), []);
    assert.match(call('set_default_keymap', { keymap: 'nope' }).text, /Unknown keymap/);
});

test('duplicate_keymap copies every layer under a new name and abbreviation, as an added keymap with the flags of its macros', () => {
    const { state, call, unsaved, jsonOf } = fixture(json => {
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 2, macroArguments: [] };
    });
    const { result, body, text } = call('duplicate_keymap', { keymap: 'QWR', name: ' Gaming ', abbreviation: 'GAM' });
    assert.equal(result.isError, false, text);
    assertWriteReply(body);
    assert.deepEqual(body.keymap, { name: 'Gaming', abbreviation: 'GAM', isDefault: false });
    assert.deepEqual(body.riskFlags, ['typesIntoHost', 'changesKeyboard']);
    const keymaps = jsonOf(result.next).keymaps;
    const original = keymaps.find(keymap => keymap.abbreviation === 'QWR');
    const copy = keymaps.find(keymap => keymap.abbreviation === 'GAM');
    assert.deepEqual(copy.layers, original.layers);
    assert.equal(keymaps.filter(keymap => keymap.isDefault).length, 1);
    // Inserted in name order, as Agent's editor does; the fixture itself leaves Empty last.
    assert.deepEqual(keymaps.map(keymap => keymap.abbreviation), ['COM', 'COL', 'DVM', 'DVO', 'GAM', 'QWM', 'QWR', 'EMP']);
    assert.deepEqual(unsaved(result.next).map(({ id, aiTagged }) => ({ id, aiTagged })), [{ id: 'keymap:GAM', aiTagged: true }]);

    const edited = call('set_key_action', { keymap: 'GAM', layer: 'base', moduleId: 0, keyId: 26, action: 'none' }, result.next);
    assert.equal(edited.result.isError, false, edited.text);
    assert.deepEqual(jsonOf(edited.result.next).keymaps.find(keymap => keymap.abbreviation === 'QWR'), jsonOf(state).keymaps.find(keymap => keymap.abbreviation === 'QWR'));
});

test('duplicate_keymap refuses a taken name or abbreviation and an abbreviation Agent would change', () => {
    const { call } = fixture();
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
        [{ name: 'QWERTY for Mac', abbreviation: 'GAM' }, /keymap with that name already exists/],
        [{ name: '  ', abbreviation: 'GAM' }, /non-empty keymap name/],
        [{ name: 'Gaming', abbreviation: 'QWM' }, /keymap with that abbreviation already exists/],
        [{ name: 'Gaming', abbreviation: 'gam' }, /1 to 3 uppercase letters or digits/],
        [{ name: 'Gaming', abbreviation: 'GAME' }, /1 to 3 uppercase letters or digits/],
        [{ name: 'Gaming', abbreviation: 'G$' }, /1 to 3 uppercase letters or digits/],
        [{ name: 'Gaming' }, /1 to 3 uppercase letters or digits/],
        [{ name: 'Gaming', abbreviation: 123 }, /1 to 3 uppercase letters or digits/],
        [{ keymap: 'nope', name: 'Gaming', abbreviation: 'GAM' }, /Unknown keymap/],
    ];
    for (const [args, message] of refusals) {
        const { result, text } = call('duplicate_keymap', { keymap: 'QWR', ...args });
        assert.equal(result.isError, true, JSON.stringify(args));
        assert.equal(result.next, undefined);
        assert.match(text, message, JSON.stringify(args));
    }
    const extended = call('duplicate_keymap', { keymap: 'QWR', name: 'Gaming', abbreviation: 'G$' }, { extraLedCharacters: true });
    assert.equal(extended.result.isError, false, extended.text);
    assert.match(call('duplicate_keymap', { keymap: 'QWR', name: 'Gaming', abbreviation: 'g$' }, { extraLedCharacters: true }).text,
        /uppercase letters, digits, spaces or any of/);
    assert.match(call('duplicate_keymap', { keymap: 'QWR', name: 'Gaming', abbreviation: '   ' }, { extraLedCharacters: true }).text,
        /uppercase letters, digits, spaces or any of/);
});

function switchesTo(json: Json, abbreviation: string): string[] {
    return json.keymaps.flatMap(keymap => keymap.layers.flatMap(layer => layer.modules.flatMap(module => module.keyActions
        .map((action: { keyActionType?: string; keymapAbbreviation?: string }, keyId: number) =>
            action?.keyActionType === 'switchKeymap' && action.keymapAbbreviation === abbreviation ? `${keymap.abbreviation}/${layer.id}/${module.id}/${keyId}` : '')
        .filter(Boolean))));
}

test('rename_keymap changes the name and description as one keymap entry with no flags', () => {
    const { call, unsaved, jsonOf } = fixture();
    const { result, body, text } = call('rename_keymap', { keymap: 'QWR', name: 'Work', description: 'Office layout' });
    assert.equal(result.isError, false, text);
    assertWriteReply(body);
    assert.deepEqual(body.keymap, { name: 'Work', abbreviation: 'QWR', isDefault: true });
    assert.equal(result.next.renamedKeymap, undefined);
    assert.deepEqual(body.riskFlags, []);
    const renamed = jsonOf(result.next).keymaps.find(keymap => keymap.abbreviation === 'QWR');
    assert.deepEqual([renamed.name, renamed.description], ['Work', 'Office layout']);
    assert.deepEqual(unsaved(result.next).map(({ id, aiTagged }) => ({ id, aiTagged })), [{ id: 'other:keymaps.QWR', aiTagged: true }]);
});

test('rename_keymap with a new abbreviation keeps every key that switches to the keymap working', () => {
    const { state, call, unsaved, jsonOf } = fixture(json => {
        baseKeys(json, 'COL')[27] = { keyActionType: 'switchKeymap', keymapAbbreviation: 'COL' };
        // QWR's only base-layer way to reach COL, so a lost binding would flag a lockout.
        baseKeys(json)[27] = { keyActionType: 'switchKeymap', keymapAbbreviation: 'COL' };
    });
    const before = switchesTo(jsonOf(state), 'COL');
    assert.equal(before.length, 7);
    const { result, body, text } = call('rename_keymap', { keymap: 'COL', abbreviation: 'CPC' });
    assert.equal(result.isError, false, text);
    assert.deepEqual(body.keymap, { name: 'Colemak for PC', abbreviation: 'CPC', isDefault: false });
    assert.deepEqual(result.next.renamedKeymap, { from: 'COL', to: 'CPC' });
    const after = jsonOf(result.next);
    assert.deepEqual(switchesTo(after, 'COL'), []);
    assert.deepEqual(switchesTo(after, 'CPC'), before.map(key => key.replace(/^COL\//, 'CPC/')));
    const changes = unsaved(result.next);
    assert.ok(changes.every(change => change.aiTagged), JSON.stringify(changes.map(({ id, aiTagged }) => ({ id, aiTagged }))));
    assert.deepEqual(changes.filter(change => change.type === 'keymap').map(({ id, change }) => [id, change]), [['keymap:COL', 'removed'], ['keymap:CPC', 'added']]);
    assert.equal(changes.filter(change => change.type === 'keyAction').length, 6);
    assert.deepEqual(body.riskFlags, ['changesKeyboard']);
    assert.ok(changes.every(change => !change.riskFlags.includes('lockout')));
});

test('rename_keymap refuses no change, a taken name or abbreviation, and a description that is not text', () => {
    const { call } = fixture();
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
        [{}, /Provide name, abbreviation or description/],
        [{ name: 'QWERTY for Mac' }, /keymap with that name already exists/],
        [{ abbreviation: 'QWM' }, /keymap with that abbreviation already exists/],
        [{ abbreviation: 'qwr' }, /1 to 3 uppercase letters or digits/],
        [{ description: 5 }, /description must be text/],
        [{ keymap: 'nope', name: 'Work' }, /Unknown keymap/],
    ];
    for (const [args, message] of refusals) {
        const { result, text } = call('rename_keymap', { keymap: 'QWR', ...args });
        assert.equal(result.isError, true, JSON.stringify(args));
        assert.match(text, message, JSON.stringify(args));
    }
    const same = call('rename_keymap', { keymap: 'QWR', name: 'QWERTY for PC', abbreviation: 'QWR' });
    assert.equal(same.result.isError, false, same.text);
});

test('keymap writes to a keymap only Agent has tag that added keymap entry', () => {
    const { call, unsaved } = fixture();
    const added = call('duplicate_keymap', { keymap: 'QWR', name: 'Gaming', abbreviation: 'GAM' }).result.next;
    for (const [name, args] of [['rename_keymap', { name: 'Games' }], ['set_default_keymap', {}]] as const) {
        const { result } = call(name, { keymap: 'GAM', ...args }, { config: added.config, aiTags: [] });
        assert.equal(result.isError, false, result.content[0].text);
        const ids = unsaved(result.next).filter(change => change.aiTagged).map(change => change.id);
        assert.ok(ids.includes('keymap:GAM'), `${name}: ${ids.join()}`);
    }
});

test('delete_keymap removes a keymap no other key switches to, as a removed keymap entry that changes the keyboard', () => {
    const { call, unsaved, jsonOf } = fixture(json => {
        baseKeys(json, 'EMP')[27] = { keyActionType: 'switchKeymap', keymapAbbreviation: 'EMP' };
    });
    const { result, body, text } = call('delete_keymap', { keymap: 'Empty' });
    assert.equal(result.isError, false, text);
    assertWriteReply(body);
    assert.deepEqual({ name: body.name, abbreviation: body.abbreviation, keymap: body.keymap }, { name: 'Empty', abbreviation: 'EMP', keymap: null });
    assert.deepEqual(body.riskFlags, ['changesKeyboard']);
    assert.equal(jsonOf(result.next).keymaps.some(keymap => keymap.abbreviation === 'EMP'), false);
    assert.deepEqual(unsaved(result.next).map(({ id, change, aiTagged, riskFlags }) => ({ id, change, aiTagged, riskFlags })), [
        { id: 'keymap:EMP', change: 'removed', aiTagged: true, riskFlags: ['changesKeyboard'] },
    ]);
});

test('delete_keymap refuses the default keymap and a keymap other keys switch to, listing those keys', () => {
    const { call } = fixture();
    const defaultKeymap = call('delete_keymap', { keymap: 'QWR' });
    assert.equal(defaultKeymap.result.isError, true);
    assert.equal(defaultKeymap.result.next, undefined);
    assert.match(defaultKeymap.text, /default keymap.*set_default_keymap/);

    const target = call('delete_keymap', { keymap: 'COL' });
    assert.equal(target.result.isError, true);
    assert.equal(target.result.next, undefined);
    const { message, keys } = target.body as { message: string; keys: unknown[] };
    assert.match(message, /Other keys switch to this keymap/);
    assert.match(message, /once a proposal passes the checks/i);
    assert.deepEqual(keys, ['COM', 'DVM', 'DVO', 'QWM', 'QWR'].map(keymap => ({
        keymap, layer: 'fn', moduleId: 1, keyId: 3, label: keyLabel(1, 3),
    })));
    assert.match(call('delete_keymap', { keymap: 'nope' }).text, /Unknown keymap/);
});

test('a base-layer switch moved to another keymap still flags a possible lockout unless it follows a rename', () => {
    const switchTo = (keymapAbbreviation: string) => ({ keyActionType: 'switchKeymap', keymapAbbreviation });
    const only = (json: Json) => {
        for (const module of json.keymaps.find(keymap => keymap.abbreviation === 'QWR').layers.find(layer => layer.id === 'base').modules) {
            module.keyActions = module.keyActions.map((action: { keyActionType?: string }) => action?.keyActionType === 'switchKeymap' ? { keyActionType: 'none' } : action);
        }
    };
    const { state, call, unsaved } = fixture(json => {
        only(json);
        baseKeys(json)[27] = switchTo('EMP');
    });
    const args = { keymap: 'QWR', layer: 'base', moduleId: 0, keyId: 27 };
    // Both keymaps still exist, so the binding to EMP is lost.
    assert.deepEqual(call('set_key_action', { ...args, action: switchTo('COL') }).body.riskFlags, ['changesKeyboard', 'lockout']);
    // GAM is not on the keyboard, but EMP still exists: a retarget to a new keymap, not a rename.
    const added = call('duplicate_keymap', { keymap: 'QWR', name: 'Gaming', abbreviation: 'GAM' }).result.next;
    const toNew = call('set_key_action', { ...args, action: switchTo('GAM') }, added).result.next;
    assert.deepEqual(unsaved(toNew).find(change => change.type === 'keyAction').riskFlags, ['changesKeyboard', 'lockout']);
    // EMP is gone, but COL was already on the keyboard: a retarget, not a rename.
    const current = state.config.clone();
    current.keymaps = current.keymaps.filter(keymap => keymap.abbreviation !== 'EMP');
    const retargeted = call('set_key_action', { ...args, action: switchTo('COL') }, { config: current }).result.next;
    const entry = unsaved(retargeted).find(change => change.type === 'keyAction');
    assert.deepEqual(entry.riskFlags, ['changesKeyboard', 'lockout']);
});
