import {
    Keymap, Macro, TextMacroAction, CommandMacroAction, MAX_ALLOWED_MACROS, US_BASIC_SCANCODE_TEXTS, UHK_80_USER_CONFIG, UserConfiguration,
    type McpToolCall,
} from 'uhk-common';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcpTool, type McpDeviceInfo } from './tool-handler.js';

import { getDefaultQwertyKeyLabel } from '../util/get-default-key-label.js';

const defaultUserConfiguration = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
const keyLabel = (moduleId: number, keyId: number) => getDefaultQwertyKeyLabel({
    defaultUserConfiguration, moduleId, keyId,
    mapper: { scanCodeToText: code => US_BASIC_SCANCODE_TEXTS[code] || [String(code)] },
});
const baseState = { keyLabel, statusText: '' };
const emptyState = { ...baseState, config: new UserConfiguration() };
const call = { name: 'get_device_info' };

test('get_device_info serializes the current device info', () => {
    const info = {
        connected: true,
        model: 'UHK 80',
        firmwareVersion: '18.0.5',
        halves: { left: true, right: true, merged: false },
    };
    const reply = handleMcpTool({ ...emptyState, info }, call);
    assert.deepEqual(JSON.parse(reply.content[0].text), info);
    assert.notEqual(reply.isError, true);
});

test('get_device_info asks the caller to retry while Agent is still loading', () => {
    const reply = handleMcpTool(emptyState, call);
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /still loading/);
});

test('unknown tools return a clear error', () => {
    const reply = handleMcpTool(emptyState, { name: 'save_to_keyboard' });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /Unknown tool/);
});

test('get_macro_errors returns firmware diagnostics and the exact cached status text', () => {
    const statusText = [
        'before: 12',
        'Error at Test macro 2/17/9: Unrecognized argument: 1/2/3:',
        '> 17 | tapKey 1/2/3:',
        '>    |         ^',
        'after:  34',
        'Warning at Old name 1/5/2: Deprecated & still supported',
        '> Position not available here.',
        'Error at Truncated report 1/2/3:',
        '',
    ].join('\n');
    const state = { ...emptyState, statusText };
    const reply = handleMcpTool(state, { name: 'get_macro_errors' });
    assert.equal(reply.isError, false);
    assert.deepEqual(JSON.parse(reply.content[0].text), { statusText, errors: [
        { macro: 'Test macro', action: 2, line: 17, column: 9, message: 'Unrecognized argument: 1/2/3:' },
        { macro: 'Old name', action: 1, line: 5, column: 2, message: 'Deprecated & still supported' },
        { macro: 'Truncated report', action: 1, line: 2, column: 3, message: '' },
    ] });
});

test('get_macro_errors tells the user to press the key when Agent has no cached errors', () => {
    for (const statusText of ['', 'value: 42']) {
        const reply = handleMcpTool({ ...emptyState, statusText }, { name: 'get_macro_errors' });
        assert.equal(reply.isError, false);
        const result = JSON.parse(reply.content[0].text) as { errors: unknown[]; statusText: string; summary: string };
        assert.deepEqual(result.errors, []);
        assert.equal(result.statusText, statusText);
        assert.match(result.summary, /macro loaded/);
        assert.match(result.summary, /press the assigned key to verify that it works/);
    }
});

test('list_keymaps reads a renamed keymap and its layers from the current configuration', () => {
    const config = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    config.keymaps[0].name = 'Unsaved layout';
    const reply = handleMcpTool({ ...baseState, config }, { name: 'list_keymaps' });
    const [first] = JSON.parse(reply.content[0].text);
    assert.equal(first.name, 'Unsaved layout');
    assert.ok(first.layers.includes('base'));
});

test('get_layer returns physical labels and the serialized actions of the requested layer', () => {
    const config = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    const keymap = config.keymaps[0];
    const reply = handleMcpTool({ ...baseState, config }, {
        name: 'get_layer', arguments: { keymap: keymap.name, layer: 'base' },
    });
    const keys: Array<{ moduleId: number; keyId: number; label: string; action: unknown }> = JSON.parse(reply.content[0].text).keys;
    const layers: Array<{ id: string; modules: Array<{ id: number; keyActions: unknown[] }> }> =
        config.toJsonObject().keymaps[0].layers;
    const layer = layers.find(layer => layer.id === 'base');
    assert.equal(keys.find(key => key.moduleId === 0 && key.keyId === 27).label, 'RShift');
    assert.equal(keys.find(key => key.moduleId === 0 && key.keyId === 29).label, 'Fn');
    assert.ok(keys.some(key => key.label === 'J'));
    assert.deepEqual(keys.map(({ moduleId, keyId, action }) => ({ moduleId, keyId, action })), layer.modules.flatMap(module => module.keyActions.map((action, keyId) => ({
        moduleId: module.id, keyId, action,
    }))));
});

function macroFixture() {
    const config = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    const text = '🧪abc';
    const command = 'write visible';
    config.macros = [Object.assign(new Macro(), { name: 'Mixed', macroActions: [
        Object.assign(new TextMacroAction(), { text }),
        Object.assign(new CommandMacroAction(), { command }),
    ] })];
    return { config, text, command };
}

test('get_macro hides text by default, leaves commands readable and honors explicit reveal', () => {
    const { config, text, command } = macroFixture();
    const call = { name: 'get_macro', arguments: { name: 'Mixed' } };
    for (const revealTextMacros of [false, true, false]) {
        const reply = handleMcpTool({ ...baseState, config }, call, revealTextMacros);
        const actions = JSON.parse(reply.content[0].text).macroActions;
        assert.equal(actions[0].text === (revealTextMacros ? text : '[text macro, 4 characters, hidden]'), true);
        assert.equal(actions[1].command, command);
    }
});

test('list_macros only lists names and action types even when reveal is enabled', () => {
    const { config } = macroFixture();
    const reply = handleMcpTool({ ...baseState, config }, { name: 'list_macros' }, true);
    assert.deepEqual(JSON.parse(reply.content[0].text), [{ name: 'Mixed', actionTypes: ['text', 'command'] }]);
});

test('unknown names identify the failed lookup without echoing input', () => {
    const { config, text } = macroFixture();
    for (const [call, message] of [
        [{ name: 'get_macro', arguments: { name: text } }, /Unknown macro/],
        [{ name: 'get_layer', arguments: { keymap: text, layer: 'base' } }, /Unknown keymap/],
        [{ name: 'get_layer', arguments: { keymap: config.keymaps[0].name, layer: text } }, /Unknown layer/],
    ] as const) {
        const reply = handleMcpTool({ ...baseState, config }, call);
        assert.equal(reply.isError, true);
        assert.match(reply.content[0].text, message);
        assert.equal(reply.content[0].text.includes(text), false);
    }
});

test('no read tool discloses a hidden text action', () => {
    const { config, text } = macroFixture();
    const info: McpDeviceInfo = { connected: false, model: null, firmwareVersion: null, halves: { left: false, right: false, merged: false } };
    for (const call of [
        { name: 'get_device_info' }, { name: 'list_keymaps' }, { name: 'list_macros' },
        { name: 'get_layer', arguments: { keymap: config.keymaps[0].name, layer: 'base' } },
        { name: 'get_macro', arguments: { name: 'Mixed' } }, { name: 'get_macro_errors' },
    ]) {
        const reply = handleMcpTool({ ...baseState, config, info }, call);
        assert.ok(!reply.isError);
        assert.equal(JSON.stringify(reply).includes(text), false);
    }
});

test('get_layer resolves the listed abbreviation when keymap names coincide', () => {
    const config = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    const [first, second] = config.keymaps;
    second.name = first.name;
    first.layers = [];
    const read = (keymap: string) => handleMcpTool({ ...baseState, config }, {
        name: 'get_layer', arguments: { keymap, layer: 'base' },
    });
    assert.match(read(first.name).content[0].text, /ambiguous/i);
    assert.ok(!read(second.abbreviation).isError);
});

test('a one-character text action leaves names, labels and errors intact', () => {
    const { config } = macroFixture();
    const macro = config.macros[0];
    macro.name = 'Email';
    (macro.macroActions[0] as TextMacroAction).text = 'a';
    config.keymaps[0].name = 'Work layout';
    const state = { ...baseState, config, keyLabel: () => 'Space' };

    const macros = handleMcpTool(state, { name: 'list_macros' });
    const [listedMacro] = JSON.parse(macros.content[0].text);
    assert.equal(listedMacro.name, 'Email');
    const keymaps = handleMcpTool(state, { name: 'list_keymaps' });
    const [listedKeymap] = JSON.parse(keymaps.content[0].text);
    assert.equal(listedKeymap.name, 'Work layout');

    const layer = handleMcpTool(state, {
        name: 'get_layer', arguments: { keymap: listedKeymap.name, layer: 'base' },
    });
    assert.equal(JSON.parse(layer.content[0].text).keys[0].label, 'Space');
    const details = handleMcpTool(state, { name: 'get_macro', arguments: { name: listedMacro.name } });
    assert.equal(JSON.parse(details.content[0].text).macroActions[0].text, '[text macro, 1 characters, hidden]');

    const error = handleMcpTool(state, { name: 'get_macro', arguments: { name: 'missing' } });
    assert.equal(error.isError, true);
    assert.equal(error.content[0].text, 'Unknown macro. Use list_macros to see available names.');
});

test('unexpected serialization errors return a generic message', () => {
    const { config, text } = macroFixture();
    config.macros[0].toJsonObject = () => { throw new Error(text); };
    const reply = handleMcpTool({ ...baseState, config }, { name: 'get_macro', arguments: { name: 'Mixed' } });
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0].text, 'Could not read the user configuration.');
});

test('short text actions preserve serializer vocabulary and full smart commands', () => {
    const { config, command } = macroFixture();
    (config.macros[0].macroActions[0] as TextMacroAction).text = 'e';
    const reply = handleMcpTool({ ...baseState, config }, { name: 'get_macro', arguments: { name: 'Mixed' } });
    const [typed, smart] = JSON.parse(reply.content[0].text).macroActions;
    assert.equal(typed.macroActionType, 'text');
    assert.equal(typed.text, '[text macro, 1 characters, hidden]');
    assert.equal(smart.command, command);
    const list = handleMcpTool({ ...baseState, config }, { name: 'list_macros' });
    assert.deepEqual(JSON.parse(list.content[0].text)[0].actionTypes, ['text', 'command']);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unsavedFixture(edit: (json: any) => void = () => {}, setup: (json: any) => void = () => {}) {
    const json = structuredClone(UHK_80_USER_CONFIG);
    setup(json);
    const baseline = new UserConfiguration().fromJsonObject(json).toJsonObject();
    const edited = structuredClone(baseline);
    edit(edited);
    const config = new UserConfiguration().fromJsonObject(edited);
    const read = (state: Partial<Parameters<typeof handleMcpTool>[0]> = {}, reveal = false) => {
        const reply = handleMcpTool({ ...baseState, config, baseline, ...state }, { name: 'get_unsaved_changes' }, reveal);
        return { reply, body: reply.isError ? reply.content[0].text : JSON.parse(reply.content[0].text) };
    };
    return { baseline, config, read };
}

test('get_unsaved_changes says there are none when Agent matches the keyboard', () => {
    const { read } = unsavedFixture();
    const { reply, body } = read();
    assert.ok(!reply.isError);
    assert.deepEqual(body.changes, []);
    assert.match((body as { summary: string }).summary, /no unsaved changes/i);
});

test('get_unsaved_changes reports that the keyboard configuration is unknown without a baseline', () => {
    const { read } = unsavedFixture();
    const { reply } = read({ baseline: undefined });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /does not know the keyboard's configuration/);
});

test('get_unsaved_changes lists an edited key with its label and both actions', () => {
    const none = { keyActionType: 'none' };
    let abbreviation: string;
    let before: unknown;
    const { read } = unsavedFixture(json => {
        abbreviation = json.keymaps[0].abbreviation;
        const keyActions = json.keymaps[0].layers.find(layer => layer.id === 'base').modules.find(module => module.id === 0).keyActions;
        before = keyActions[27];
        keyActions[27] = none;
    });
    const { body } = read();
    assert.deepEqual(body.changes, [{
        id: `key:${abbreviation}/base/0/27`,
        type: 'keyAction',
        keymap: abbreviation,
        layer: 'base',
        moduleId: 0,
        keyId: 27,
        label: 'RShift',
        before,
        after: none,
        aiTagged: false,
        riskFlags: [],
    }]);
    assert.match((body as { summary: string }).summary, /^1 unsaved change, 0 AI-tagged\./);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baseKeys = (json: any) => json.keymaps[0].layers.find(layer => layer.id === 'base').modules.find(module => module.id === 0).keyActions;
const newMacro = { isLooped: false, isPrivate: true, name: 'AAA first', macroActions: [{ macroActionType: 'delay', delay: 50 }] };

test('get_unsaved_changes lists an added macro without reporting keys whose macro index shifted', () => {
    const { read } = unsavedFixture(json => {
        json.macros.unshift(newMacro);
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 3, macroArguments: [] };
    }, json => {
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 2, macroArguments: [] };
    });
    const { body } = read();
    assert.deepEqual(body.changes, [{
        id: 'macro:AAA first', type: 'macro', name: 'AAA first', change: 'added', before: null, after: newMacro, aiTagged: false, riskFlags: [],
    }]);
});

test('get_unsaved_changes reports a key that now plays a different macro by name', () => {
    const { read } = unsavedFixture(json => {
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 1, macroArguments: [] };
    }, json => {
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 2, macroArguments: [] };
    });
    const [entry] = read().body.changes;
    assert.equal(entry.before.macroName, "Type Silent Bob's address");
    assert.equal(entry.after.macroName, 'God mode in Doom');
    assert.equal('macroIndex' in entry.after, false);
});

test('get_unsaved_changes lists changed and removed macros with both versions', () => {
    let changedBefore: unknown;
    let removedBefore: unknown;
    let changedAfter: unknown;
    const { read } = unsavedFixture(json => {
        changedBefore = structuredClone(json.macros[0]);
        json.macros[0].macroActions.push({ macroActionType: 'delay', delay: 10 });
        changedAfter = json.macros[0];
        removedBefore = json.macros.pop();
    });
    const changes = read({}, true).body.changes;
    assert.deepEqual(changes, [
        { id: 'macro:Go to UHK site in browser', type: 'macro', name: 'Go to UHK site in browser', change: 'changed', before: changedBefore, after: changedAfter, aiTagged: false, riskFlags: ['typesIntoHost'] },
        { id: "macro:Type Silent Bob's address", type: 'macro', name: "Type Silent Bob's address", change: 'removed', before: removedBefore, after: null, aiTagged: false, riskFlags: [] },
    ]);
});

test('get_unsaved_changes lists keymap details and settings as other changes, ignoring save metadata', () => {
    let abbreviation: string;
    let speed: number;
    let name: string;
    const { read } = unsavedFixture(json => {
        abbreviation = json.keymaps[0].abbreviation;
        name = json.keymaps[0].name;
        json.keymaps[0].name = 'Renamed';
        speed = json.mouseMoveInitialSpeed;
        json.mouseMoveInitialSpeed = speed + 1;
        json.lastSaveAgentTag = 'elsewhere/v0';
        json.userConfigPatchVersion += 1;
    });
    const changes = read().body.changes;
    assert.deepEqual(changes.map(({ id, type }) => ({ id, type })), [
        { id: `other:keymaps.${abbreviation}`, type: 'other' },
        { id: 'other:mouseMoveInitialSpeed', type: 'other' },
    ]);
    assert.equal(changes[0].path, `keymaps.${abbreviation}`);
    assert.equal(changes[0].before.name, name);
    assert.equal(changes[0].after.name, 'Renamed');
    assert.equal('layers' in changes[0].after, false);
    assert.deepEqual([changes[1].before, changes[1].after], [speed, speed + 1]);
});

test('get_unsaved_changes reports a duplicated keymap as one added entry without its keys', () => {
    const { read } = unsavedFixture(json => {
        json.keymaps.push({ ...structuredClone(json.keymaps[0]), abbreviation: 'NEW', name: 'New', isDefault: false });
    });
    assert.deepEqual(read().body.changes, [
        { id: 'keymap:NEW', type: 'keymap', change: 'added', abbreviation: 'NEW', name: 'New', aiTagged: false, riskFlags: ['changesKeyboard'] },
    ]);
});

test('get_unsaved_changes reports a deleted keymap as one removed entry without its keys', () => {
    let abbreviation: string;
    let name: string;
    const { read } = unsavedFixture(json => {
        // Deleting a keymap in Agent also rewrites keys that switch to it, so pick one no key switches to.
        const targets = new Set<string>();
        for (const keymap of json.keymaps) for (const layer of keymap.layers) for (const module of layer.modules) for (const action of module.keyActions) {
            if (action?.keyActionType === 'switchKeymap') {
                targets.add(String(action.keymapAbbreviation));
            }
        }
        const index = json.keymaps.findIndex(keymap => !keymap.isDefault && !targets.has(String(keymap.abbreviation)));
        ({ abbreviation, name } = json.keymaps[index]);
        json.keymaps.splice(index, 1);
    });
    assert.deepEqual(read().body.changes, [
        { id: `keymap:${abbreviation}`, type: 'keymap', change: 'removed', abbreviation, name, aiTagged: false, riskFlags: ['changesKeyboard'] },
    ]);
});

test('get_unsaved_changes hides text macro contents on both sides unless reveal is enabled', () => {
    const secret = 'hunter2-🔑';
    let original: string;
    const { read } = unsavedFixture(json => {
        const action = json.macros.find(macro => macro.name === 'God mode in Doom').macroActions[0];
        original = action.text;
        action.text = secret;
    });
    const hidden = read();
    assert.ok(!hidden.reply.isError);
    const text = hidden.reply.content[0].text;
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(original), false);
    const [entry] = hidden.body.changes;
    assert.equal(entry.before.macroActions[0].text, `[text macro, ${Array.from(original).length} characters, hidden]`);
    assert.equal(entry.after.macroActions[0].text, '[text macro, 9 characters, hidden]');
    assert.equal(read({}, true).body.changes[0].after.macroActions[0].text, secret);
});

test('get_unsaved_changes names no macro for a key whose macro index is out of range', () => {
    const { baseline, read } = unsavedFixture(json => {
        baseKeys(json)[27] = { keyActionType: 'none' };
    });
    baseKeys(baseline)[27] = { keyActionType: 'playMacro', macroIndex: 99, macroArguments: [] };
    const [entry] = read().body.changes;
    assert.equal(entry.before.macroName, null);
});

const connected: McpDeviceInfo = { connected: true, model: 'UHK 80', firmwareVersion: '18.0.5', halves: { left: true, right: true, merged: true } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeFixture(edit: (json: any) => void = () => {}) {
    const json = structuredClone(UHK_80_USER_CONFIG);
    edit(json);
    const config = new UserConfiguration().fromJsonObject(json);
    const baseline = config.toJsonObject();
    const abbreviation: string = config.keymaps[0].abbreviation;
    const setKey = (action: unknown, args: Record<string, unknown> = {}, state: Partial<Parameters<typeof handleMcpTool>[0]> = {}) => {
        const before = JSON.stringify(config.toJsonObject());
        const result = handleMcpTool({ ...baseState, config, baseline, info: connected, ...state }, {
            name: 'set_key_action', arguments: { keymap: abbreviation, layer: 'base', moduleId: 0, keyId: 27, action, ...args },
        });
        assert.equal(JSON.stringify(config.toJsonObject()), before, 'the input configuration is not mutated');
        return { result, body: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
    };
    return { config, baseline, abbreviation, setKey };
}

const keystrokeA = { keyActionType: 'keystroke', type: 'basic', scancode: 4 };

test('set_key_action returns the resulting action and a next configuration with only that key changed', () => {
    const { abbreviation, baseline, setKey } = writeFixture();
    const { result, body } = setKey(keystrokeA);
    assert.ok(!result.isError);
    assert.equal(body.keymap, abbreviation);
    assert.equal(body.layer, 'base');
    assert.equal(body.moduleId, 0);
    assert.equal(body.keyId, 27);
    assert.equal(body.label, 'RShift');
    assert.equal(body.action.keyActionType, 'keystroke');
    assert.equal(body.action.scancode, 4);
    assert.deepEqual(body.errors, []);
    assert.match(body.summary as string, /checks prove the configuration loads, not that it works/i);
    assert.match(body.summary as string, /save to keyboard/i);
    assert.match(body.summary as string, /press the key/i);
    assert.ok(result.next);
    const changes = handleMcpTool({ ...baseState, baseline, config: result.next.config }, { name: 'get_unsaved_changes' });
    const entries = JSON.parse(changes.content[0].text).changes;
    assert.deepEqual(entries.map(entry => entry.id), [`key:${abbreviation}/base/0/27`]);
    assert.equal(entries[0].after.scancode, 4);
    assert.equal(JSON.stringify(result.next).includes('content'), false, 'the next state is kept apart from the reply');
});

test('set_key_action with none clears the key', () => {
    const { setKey } = writeFixture();
    for (const action of ['none', { keyActionType: 'none' }]) {
        const { result, body } = setKey(action);
        assert.ok(!result.isError);
        assert.equal(body.action.keyActionType, 'none');
        assert.equal(result.next.config.keymaps[0].layers[0].modules.find(module => module.id === 0).keyActions[27].constructor.name, 'NoneAction');
    }
});

test('set_key_action refuses a write that fails a structural check and leaves the configuration unchanged', () => {
    const { setKey, abbreviation } = writeFixture();
    for (const [action, args, message] of [
        [keystrokeA, { keymap: 'missing' }, /Unknown keymap/],
        [keystrokeA, { layer: 'missing' }, /Unknown layer/],
        [keystrokeA, { moduleId: 99 }, /Unknown module/],
        [keystrokeA, { keyId: 999 }, /Unknown key/],
        [keystrokeA, { keyId: -1 }, /Unknown key/],
        [keystrokeA, { keyId: 1.5 }, /Unknown key/],
        [keystrokeA, { keyId: '27' }, /Unknown key/],
        [null, {}, /serializer JSON shape/],
        [[keystrokeA], {}, /serializer JSON shape/],
        [{ keyActionType: 'playMacro', macroIndex: '0', macroArguments: [] }, {}, /Unknown macro/],
        [{ keyActionType: 'playMacro', macroIndex: 0.5, macroArguments: [] }, {}, /Unknown macro/],
        [{ keyActionType: 'playMacro', macroIndex: 99, macroArguments: [] }, {}, /Unknown macro/],
        [{ keyActionType: 'switchKeymap', keymapAbbreviation: 'NOPE' }, {}, /Unknown keymap abbreviation/],
        [{ keyActionType: 'teleport' }, {}, /not a valid key action/],
        [{ keyActionType: 'keystroke', type: 'basic', scancode: 0 }, {}, /does nothing/],
        ['clear', {}, /serializer JSON shape/],
        [{ keyActionType: 'switchLayer', layer: 'nowhere', switchLayerMode: 'toggle' }, {}, /did not recognize the value of layer/],
        [{ keyActionType: 'mouse', mouseAction: 'fly' }, {}, /did not recognize the value of mouseAction/],
    ] as const) {
        const { result } = setKey(action, args);
        assert.equal(result.isError, true, `${JSON.stringify(action)} ${JSON.stringify(args)}`);
        assert.match(result.content[0].text, message);
        assert.equal(result.next, undefined);
    }
    assert.ok(abbreviation);
});

test('set_key_action reports a clear error when no keyboard is connected', () => {
    const { setKey } = writeFixture();
    const disconnected = { ...connected, connected: false, model: null, firmwareVersion: null };
    const { result } = setKey(keystrokeA, {}, { info: disconnected });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No keyboard is connected/);
    assert.equal(result.next, undefined);
    assert.match(setKey(keystrokeA, {}, { info: undefined }).result.content[0].text, /still loading/);
});

test('set_key_action accepts every action of the default configuration as get_layer returns it', () => {
    const { config, abbreviation, setKey } = writeFixture();
    for (const layer of ['base', 'fn', 'mod', 'mouse']) {
        const read = handleMcpTool({ ...baseState, config }, { name: 'get_layer', arguments: { keymap: abbreviation, layer } });
        for (const { moduleId, keyId, action } of JSON.parse(read.content[0].text).keys) {
            const { result, body } = setKey(action, { layer, moduleId, keyId });
            assert.ok(!result.isError, `${layer}/${moduleId}/${keyId}: ${JSON.stringify(body)}`);
            assert.deepEqual(body.action, action);
        }
    }
});

test('set_key_action tags the changed key and get_unsaved_changes shows the tags and their count', () => {
    const { abbreviation, baseline, setKey } = writeFixture();
    const earlier = 'macro:Earlier AI macro';
    const { result } = setKey(keystrokeA, {}, { aiTags: [earlier] });
    const keyId = `key:${abbreviation}/base/0/27`;
    assert.deepEqual(result.next.aiTags, [earlier, keyId]);
    assert.deepEqual(setKey(keystrokeA, {}, { aiTags: [keyId] }).result.next.aiTags, [keyId], 'a tag is listed once');

    const config = result.next.config;
    config.mouseMoveInitialSpeed += 1;
    const reply = handleMcpTool({ ...baseState, baseline, config, aiTags: result.next.aiTags }, { name: 'get_unsaved_changes' });
    const body = JSON.parse(reply.content[0].text);
    assert.deepEqual(body.changes.map(({ id, aiTagged }) => ({ id, aiTagged })), [
        { id: keyId, aiTagged: true },
        { id: 'other:mouseMoveInitialSpeed', aiTagged: false },
    ]);
    assert.match(body.summary as string, /^2 unsaved changes, 1 AI-tagged\./);
});

test('set_key_action replies, successful or refused, do not disclose a hidden text action', () => {
    const secret = 'hunter2-🔑';
    const { setKey } = writeFixture(json => {
        json.macros[0].macroActions = [{ macroActionType: 'text', text: secret }];
    });
    for (const action of [{ keyActionType: 'playMacro', macroIndex: 0, macroArguments: [] }, { keyActionType: 'playMacro', macroIndex: 99 }]) {
        const { result } = setKey(action);
        assert.equal(result.content[0].text.includes(secret), false);
    }
});

test('set_key_action refuses a layer switch or secondary role to a layer the keymap does not have', () => {
    const { setKey } = writeFixture(json => {
        json.keymaps[0].layers = json.keymaps[0].layers.filter(layer => layer.id !== 'fn4');
    });
    for (const action of [
        { keyActionType: 'switchLayer', layer: 'fn4', switchLayerMode: 'hold' },
        { keyActionType: 'keystroke', type: 'basic', scancode: 4, secondaryRoleAction: 'fn4' },
    ]) {
        const { result } = setKey(action);
        assert.equal(result.isError, true, JSON.stringify(action));
        assert.match(result.content[0].text, /keymap has no fn4 layer/);
    }
});

test('a key changed in a keymap that only Agent has tags that keymap entry', () => {
    const { config, baseline } = writeFixture();
    const added = config.clone();
    const copy = new Keymap(added.keymaps[0]);
    copy.abbreviation = 'NEW';
    copy.name = 'New';
    copy.isDefault = false;
    added.keymaps.push(copy);
    const state = { ...baseState, baseline, info: connected };
    const { next } = handleMcpTool({ ...state, config: added }, {
        name: 'set_key_action', arguments: { keymap: 'NEW', layer: 'base', moduleId: 0, keyId: 27, action: keystrokeA },
    });
    assert.deepEqual(next.aiTags, ['keymap:NEW']);
    const body = JSON.parse(handleMcpTool({ ...state, config: next.config, aiTags: next.aiTags }, { name: 'get_unsaved_changes' }).content[0].text);
    assert.deepEqual(body.changes.map(({ id, aiTagged }) => ({ id, aiTagged })), [{ id: 'keymap:NEW', aiTagged: true }]);
});

test('set_key_action keeps a key label and accepts a macro key with arguments', () => {
    const { setKey } = writeFixture();
    const labelled = setKey({ ...keystrokeA, label: 'Mail' });
    assert.ok(!labelled.result.isError);
    assert.equal(labelled.body.action.label, 'Mail');
    const macro = { keyActionType: 'playMacro', macroIndex: 0, macroArguments: [] };
    const played = setKey(macro);
    assert.ok(!played.result.isError, JSON.stringify(played.body));
    assert.equal(played.body.action.macroIndex, 0);
});

test('an unexpected failure during a write says nothing was changed', () => {
    const { setKey } = writeFixture();
    const { result } = setKey(keystrokeA, {}, { keyLabel: () => { throw new Error('boom'); } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Could not change the user configuration\. Nothing was changed\./);
    assert.match(result.content[0].text, /once a proposal passes the checks.*save to keyboard.*press the key/i);
    assert.equal(result.next, undefined);
});

function callMacroTool(state: Parameters<typeof handleMcpTool>[0], name: string, args: Record<string, unknown>) {
    const before = state.config.toJsonObject();
    const result = handleMcpTool(state, { name, arguments: args });
    assert.deepEqual(state.config.toJsonObject(), before, 'the input configuration is not mutated');
    const body = result.isError ? result.content[0].text : JSON.parse(result.content[0].text);
    return { result, body };
}

function assertMacroWriteReply(reply: unknown) {
    const body = reply as { errors: unknown[]; summary: string };
    assert.deepEqual(body.errors, []);
    assert.match(body.summary, /checks prove the configuration loads, not that it works/i);
    assert.match(body.summary, /save to keyboard/i);
    assert.match(body.summary, /press the key/i);
}

test('creating an event macro flags both the write and its unsaved entry regardless of supplied flags', () => {
    const { config, baseline } = writeFixture();
    const state = { ...baseState, config, baseline, info: connected };
    const { result, body } = callMacroTool(state, 'create_macro', {
        name: '$onInit', macroActions: [{ macroActionType: 'delay', delay: 10 }], riskFlags: [],
    });
    assert.equal(result.isError, false, result.content[0].text);
    assert.deepEqual(body.riskFlags, ['runsWithoutKeyPress']);

    const reply = handleMcpTool({ ...state, ...result.next }, { name: 'get_unsaved_changes' });
    const [entry] = JSON.parse(reply.content[0].text).changes;
    assert.equal(entry.aiTagged, true);
    assert.deepEqual(entry.riskFlags, ['runsWithoutKeyPress']);
});

test('a text macro edited by hand is flagged while its text remains hidden', () => {
    const { read } = unsavedFixture(json => {
        json.macros.push({
            ...newMacro, macroActions: [{ macroActionType: 'text', text: 'fixture' }],
        });
    });
    const [entry] = read().body.changes;
    assert.equal(entry.aiTagged, false);
    assert.deepEqual(entry.riskFlags, ['typesIntoHost']);
    assert.equal(entry.after.macroActions[0].text, '[text macro, 7 characters, hidden]');
});

test('a launcher chord is flagged in a key write', () => {
    const { setKey } = writeFixture();
    const { result, body } = setKey({ keyActionType: 'keystroke', type: 'basic', scancode: 21, modifierMask: 8 });
    assert.equal(result.isError, false, result.content[0].text);
    assert.deepEqual(body.riskFlags, ['opensLauncherOrShell']);
});

test('smart-macro launcher chords support command prefixes, sequences and modifier releases', () => {
    const launcher = ['typesIntoHost', 'opensLauncherOrShell'];
    for (const [command, expected] of [
        ['launch: ifShift tapKey LG-space // launcher', launcher],
        ['autoRepeat tapKey LG-space', launcher],
        ['tapKeySeq pLG- space rLG-', launcher],
        ['pressKey LG-\ntapKey space\nreleaseKey LG-', launcher],
        ['tapKeySeq pLG- rLG- space', ['typesIntoHost']],
        ['tapKeySeq rLG-space', []],
        ['tapKeySeq space // LG-space', ['typesIntoHost']],
        ['tapKey iLG-space', ['typesIntoHost']],
        ['tapKey iLSRG-space', ['typesIntoHost']],
        ['tapKey iLSoRG-space', launcher],
    ] as const) {
        const { read } = unsavedFixture(json => {
            json.macros.push({ ...newMacro, macroActions: [{ macroActionType: 'command', command }] });
        });
        assert.deepEqual(read().body.changes[0].riskFlags, expected, command);
    }
});

test('computed text and calls into other macros cannot be checked', () => {
    for (const [command, riskFlags] of [
        ['write "value: $macroArg.1"', ['typesIntoHost', 'cannotBeChecked']],
        ['write \'Value: \'"$macroArg.1"', ['typesIntoHost', 'cannotBeChecked']],
        ['&macroArg.1', ['cannotBeChecked']],
        ['call Other macro', ['cannotBeChecked']],
        ['exec Other macro', ['cannotBeChecked']],
        ['fork Other macro', ['cannotBeChecked']],
        ["write '$literal // call Other macro'", ['typesIntoHost']],
        ['write "literal \\$dollar"\n// fork Other macro', ['typesIntoHost']],
    ] as const) {
        const { read } = unsavedFixture(json => {
            json.macros.push({ ...newMacro, macroActions: [{ macroActionType: 'command', command }] });
        });
        assert.deepEqual(read().body.changes[0].riskFlags, riskFlags, command);
    }
});

test('firmware settings changes and smart-macro configuration commands flag changes to the keyboard', () => {
    const { read } = unsavedFixture(json => {
        json.mouseMoveInitialSpeed += 1;
        json.macros.push({
            ...newMacro, macroActions: [{ macroActionType: 'command', command: 'set stickyModifiers never' }],
        });
    });
    const { changes } = read().body;
    assert.deepEqual(changes.map(entry => [entry.type, entry.riskFlags]), [
        ['macro', ['changesKeyboard']],
        ['other', ['changesKeyboard']],
    ]);
});

test('display updates and ordinary layer or keymap switches do not flag a keyboard change', () => {
    const { config, baseline } = writeFixture();
    const state = { ...baseState, config, baseline, info: connected };
    for (const command of [
        "notify 'Ready'",
        'ifShift notify set',
        "setLedTxt 1000 notification 'Ready'",
        'switchKeymap QWR',
        'toggleLayer fn',
        'holdLayer fn',
        'toggleKeymapLayer QWR fn',
    ]) {
        const { result, body } = callMacroTool(state, 'create_macro', {
            name: 'Example', macroActions: [{ macroActionType: 'command', command }],
        });
        assert.equal(result.isError, false, result.content[0].text);
        assert.deepEqual(body.riskFlags, [], command);
    }
});

test('keymap overlays, keymap replacements and power mode commands flag a keyboard change', () => {
    const { config, baseline } = writeFixture();
    const state = { ...baseState, config, baseline, info: connected };
    for (const command of ['overlayKeymap QWR', 'replaceKeymap QWR', 'powerMode wake']) {
        const { result, body } = callMacroTool(state, 'create_macro', {
            name: 'Example', macroActions: [{ macroActionType: 'command', command }],
        });
        assert.equal(result.isError, false, result.content[0].text);
        assert.deepEqual(body.riskFlags, ['changesKeyboard'], command);
    }
});

test('a command that locks the keyboard flags both the keyboard change and the lockout', () => {
    const { read } = unsavedFixture(json => {
        json.macros.push({
            ...newMacro, macroActions: [{ macroActionType: 'command', command: 'powerMode lock' }],
        });
    });
    assert.deepEqual(read().body.changes[0].riskFlags, ['changesKeyboard', 'lockout']);
});

test('native macro keystrokes flag launcher chords even when a modifier is held by a separate action', () => {
    const { read } = unsavedFixture(json => {
        json.macros.push({
            ...newMacro,
            macroActions: [
                { macroActionType: 'key', action: 'press', modifierMask: 128 },
                { macroActionType: 'delay', delay: 20 },
                { macroActionType: 'key', action: 'tap', type: 'basic', scancode: 44 },
                { macroActionType: 'key', action: 'release', modifierMask: 128 },
            ],
        });
    });
    assert.deepEqual(read().body.changes[0].riskFlags, ['typesIntoHost', 'opensLauncherOrShell']);
});

test('a metadata-only keymap edit has no flags, while switching the default changes the keyboard', () => {
    const { read } = unsavedFixture(json => {
        json.keymaps[0].name = 'Renamed';
        json.keymaps[1].isDefault = !json.keymaps[1].isDefault;
    });
    assert.deepEqual(read().body.changes.map(entry => entry.riskFlags), [[], ['changesKeyboard']]);
});

test('removing the last direct base-layer switch flags a possible lockout', () => {
    for (const alternative of [false, true]) {
        const { setKey } = writeFixture(json => {
            const layer = json.keymaps[0].layers.find(layer => layer.id === 'base');
            for (const module of layer.modules) {
                module.keyActions = module.keyActions.map(action =>
                    action.layer === 'fn' || action.secondaryRoleAction === 'fn' ? { keyActionType: 'none' } : action);
            }
            baseKeys(json)[27] = { keyActionType: 'switchLayer', layer: 'fn', switchLayerMode: 'hold' };
            if (alternative) {
                baseKeys(json)[28] = { ...keystrokeA, secondaryRoleAction: 'fn' };
            }
        });
        const { result, body } = setKey('none');
        assert.equal(result.isError, false, result.content[0].text);
        assert.deepEqual(body.riskFlags, alternative ? ['changesKeyboard'] : ['changesKeyboard', 'lockout']);
    }
});

test('assigning an existing macro flags its effects without including unrelated hand edits in the write', () => {
    const { config, baseline, setKey } = writeFixture(json => {
        json.macros.push({
            ...newMacro, macroActions: [{ macroActionType: 'text', text: 'fixture' }],
        });
    });
    const macroIndex = config.macros.findIndex(macro => macro.name === newMacro.name);
    const edited = config.clone();
    edited.mouseMoveInitialSpeed += 1;
    const { result, body } = setKey({ keyActionType: 'playMacro', macroIndex, macroArguments: [] }, {}, { config: edited });
    assert.equal(result.isError, false, result.content[0].text);
    assert.deepEqual(body.riskFlags, ['typesIntoHost']);
    const reply = handleMcpTool({ ...baseState, baseline, ...result.next }, { name: 'get_unsaved_changes' });
    assert.deepEqual(JSON.parse(reply.content[0].text).changes.map(entry => [entry.type, entry.riskFlags]), [
        ['keyAction', ['typesIntoHost']],
        ['other', ['changesKeyboard']],
    ]);
});

test('an added keymap carries a launcher flag for its keys without listing them separately', () => {
    const { read } = unsavedFixture(json => {
        const added = { ...structuredClone(json.keymaps[0]), abbreviation: 'NEW', name: 'New', isDefault: false };
        baseKeys({ keymaps: [added] })[27] = { keyActionType: 'keystroke', type: 'basic', scancode: 44, modifierMask: 128 };
        json.keymaps.push(added);
    });
    const { changes } = read().body;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, 'keymap:NEW');
    assert.ok(changes[0].riskFlags.includes('opensLauncherOrShell'));
});

test('create_macro adds a proposed change and preserves existing macro key assignments', () => {
    const { config, baseline, abbreviation } = writeFixture(json => {
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 0, macroArguments: [] };
    });
    const state = { ...baseState, config, baseline, info: connected };
    const { result, body } = callMacroTool(state, 'create_macro', newMacro);
    assert.equal(result.isError, false, result.content[0].text);
    assert.ok(result.next);
    assert.deepEqual(body.macro, newMacro);
    assertMacroWriteReply(body);
    const changes = handleMcpTool({ ...state, ...result.next }, { name: 'get_unsaved_changes' });
    assert.deepEqual(JSON.parse(changes.content[0].text).changes.map(({ id, aiTagged }) => ({ id, aiTagged })), [
        { id: 'macro:AAA first', aiTagged: true },
    ]);

    const layer = handleMcpTool({ ...state, ...result.next }, {
        name: 'get_layer', arguments: { keymap: abbreviation, layer: 'base' },
    });
    const { action } = JSON.parse(layer.content[0].text).keys.find(key => key.moduleId === 0 && key.keyId === 27);
    assert.equal(result.next.config.macros[action.macroIndex].name, config.macros[0].name);
});

test('update_macro replaces hidden text in an assigned macro and preserves its other fields and assignments', () => {
    const original = 'fixture-text-before';
    const replacement = 'fixture-text-after 🔑';
    const { config, baseline } = writeFixture(json => {
        json.macros[0].isPrivate = true;
        json.macros[0].macroActions = [{ macroActionType: 'text', text: original }];
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 0, macroArguments: [] };
    });
    const state = { ...baseState, config, baseline, info: connected };
    const { name } = config.macros[0];
    const { result, body } = callMacroTool(state, 'update_macro', {
        name, macroActions: [{ macroActionType: 'text', text: replacement }],
    });
    assert.equal(result.isError, false, result.content[0].text);
    assert.ok(result.next);
    assert.equal(body.macro.name, name);
    assert.equal(body.macro.isPrivate, true);
    assert.deepEqual(body.macro.macroActions, [{ macroActionType: 'text', text: '[text macro, 20 characters, hidden]' }]);
    assertMacroWriteReply(body);
    const revealed = handleMcpTool({ ...state, ...result.next }, { name: 'get_macro', arguments: { name } }, true);
    assert.equal(JSON.parse(revealed.content[0].text).macroActions[0].text, replacement);
    const changes = handleMcpTool({ ...state, ...result.next }, { name: 'get_unsaved_changes' });
    assert.deepEqual(JSON.parse(changes.content[0].text).changes.map(({ id, aiTagged }) => ({ id, aiTagged })), [
        { id: `macro:${name}`, aiTagged: true },
    ]);
});

test('update_macro changes only the supplied flag on a macro loaded from an older export', () => {
    const { config, baseline } = writeFixture(json => {
        delete json.macros[0].isPrivate;
        json.macros[0].macroActions = [{ macroActionType: 'delay', delay: 18 }];
    });
    const [macro] = config.macros;
    const state = { ...baseState, config, baseline, info: connected };
    const { result, body } = callMacroTool(state, 'update_macro', { name: macro.name, isLooped: false });
    assert.equal(result.isError, false, result.content[0].text);
    assert.equal(body.macro.isLooped, false);
    assert.equal(result.next.config.getMacro(macro.id).isPrivate, undefined);
    assert.deepEqual(body.macro.macroActions, [{ macroActionType: 'delay', delay: 18 }]);
});

test('rename_macro keeps key assignments and tags the renamed macro and its changed diff entries', () => {
    const { config, baseline, abbreviation } = writeFixture(json => {
        json.macros[0].macroActions = [{ macroActionType: 'delay', delay: 100 }];
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 0, macroArguments: [] };
    });
    const state = { ...baseState, config, baseline, info: connected };
    const { name } = config.macros[0];
    const newName = 'Renamed macro';
    const { result, body } = callMacroTool(state, 'rename_macro', { name, newName });
    assert.equal(result.isError, false, result.content[0].text);
    assert.ok(result.next);
    assert.deepEqual(body.macro, { ...config.macros[0].toJsonObject(), name: newName });
    assertMacroWriteReply(body);
    const changes = handleMcpTool({ ...state, ...result.next }, { name: 'get_unsaved_changes' });
    const [key, removed, added] = JSON.parse(changes.content[0].text).changes;
    assert.equal(key.id, `key:${abbreviation}/base/0/27`);
    assert.equal(key.after.macroName, newName);
    assert.equal(removed.id, `macro:${name}`);
    assert.equal(added.id, `macro:${newName}`);
    assert.ok([key, removed, added].every(change => change.aiTagged));
});

test('delete_macro lists every assigned key and removes the macro only after its assignments are cleared', () => {
    const { config, baseline, abbreviation, setKey } = writeFixture(json => {
        const assignment = { keyActionType: 'playMacro', macroIndex: 0, macroArguments: [] };
        baseKeys(json)[27] = assignment;
        baseKeys(json)[28] = assignment;
    });
    const state = { ...baseState, config, baseline, info: connected };
    const { name } = config.macros[0];
    const refused = callMacroTool(state, 'delete_macro', { name });
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.next, undefined);
    const { message, keys } = JSON.parse(refused.result.content[0].text) as { message: string; keys: unknown[] };
    assert.match(message, /assigned to/);
    assert.match(message, /once a proposal passes the checks.*save to keyboard.*press the key/i);
    assert.deepEqual(keys, [27, 28].map(keyId => ({
        keymap: abbreviation, layer: 'base', moduleId: 0, keyId, label: keyLabel(0, keyId),
    })));

    const first = setKey('none').result.next;
    const second = setKey('none', { keyId: 28 }, first).result.next;
    const deleted = callMacroTool({ ...state, ...second }, 'delete_macro', { name });
    assert.equal(deleted.result.isError, false, deleted.result.content[0].text);
    assert.deepEqual({ name: deleted.body.name, macro: deleted.body.macro }, { name, macro: null });
    assertMacroWriteReply(deleted.body);
    assert.ok(deleted.result.next);
    const after = handleMcpTool({ ...state, ...deleted.result.next }, { name: 'get_macro', arguments: { name } });
    assert.equal(after.isError, true);
    assert.ok(deleted.result.next.aiTags.includes(`macro:${name}`));
});

test('invalid macro writes leave the current configuration unchanged', () => {
    const { config, baseline } = writeFixture();
    const [existing, duplicate] = config.macros;
    const state = { ...baseState, config, baseline, info: connected };
    for (const [name, args, message] of [
        ['create_macro', { ...newMacro, name: '  ' }, /non-empty macro name/i],
        ['create_macro', { ...newMacro, name: 42 }, /non-empty macro name/i],
        ['create_macro', { ...newMacro, name: existing.name }, /already exists/i],
        ['create_macro', { name: newMacro.name, macroActions: null }, /array of macro actions/],
        ['create_macro', { ...newMacro, isLooped: 'false' }, /must be booleans/],
        ['rename_macro', { name: existing.name, newName: duplicate.name }, /already exists/i],
        ['rename_macro', { name: 'missing', newName: newMacro.name }, /unknown macro/i],
        ['delete_macro', { name: 'missing' }, /unknown macro/i],
        ['update_macro', { name: existing.name }, /provide macroActions/i],
        ['update_macro', { name: existing.name, isPrivate: 1 }, /must be booleans/],
        ['update_macro', { name: existing.name, macroActions: [{ macroActionType: 'delay', delay: 2.5 }] }, /invalid macro action/i],
        ['update_macro', { name: existing.name, macroActions: [{ macroActionType: 'delay' }] }, /invalid macro action/i],
        ['update_macro', { name: existing.name, macroActions: [{ macroActionType: 'key', action: 'unknown' }] }, /invalid macro action/i],
        ['update_macro', { name: existing.name, macroActions: [null] }, /invalid macro action at position 1/i],
        ['update_macro', { name: existing.name, macroActions: [{ macroActionType: 'text', text: 12 }] }, /invalid macro action/i],
        ['update_macro', { name: existing.name, macroActions: [{ macroActionType: 'delay', delay: 2, ignored: true }] }, /invalid macro action/i],
        ['update_macro', { name: existing.name, macroActions: [{ macroActionType: 'text', text: 'x'.repeat(65536) }] }, /would not serialize/i],
    ] as const) {
        const { result } = callMacroTool(state, name, args);
        assert.equal(result.isError, true, name);
        assert.match(result.content[0].text, message);
        assert.equal(result.next, undefined);
    }
});

test('rename_macro to the current name produces no diff or tags', () => {
    const { config, baseline } = writeFixture();
    const state = { ...baseState, config, baseline, info: connected };
    const { name } = config.macros[0];
    const { result, body } = callMacroTool(state, 'rename_macro', { name, newName: ` ${name} ` });
    assert.equal(result.isError, false, result.content[0].text);
    assert.deepEqual(body.riskFlags, []);
    assert.deepEqual(result.next.config.toJsonObject(), baseline);
    assert.deepEqual(result.next.aiTags, []);
});

test('macro writes refuse an ambiguous macro name', () => {
    const { config, baseline } = writeFixture(json => {
        json.macros[1].name = json.macros[0].name;
    });
    const state = { ...baseState, config, baseline, info: connected };
    const { result } = callMacroTool(state, 'delete_macro', { name: config.macros[0].name });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /more than one macro has that name/i);
    assert.equal(result.next, undefined);
});

test('create_macro refuses to exceed the keyboard macro limit', () => {
    const { config, baseline } = writeFixture(json => {
        const count = MAX_ALLOWED_MACROS - json.macros.length;
        json.macros.push(...Array.from({ length: count }, (_, index) => ({
            ...newMacro, name: `Extra macro ${index}`,
        })));
    });
    const state = { ...baseState, config, baseline, info: connected };
    const { result } = callMacroTool(state, 'create_macro', newMacro);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no more than 255 macros/i);
    assert.equal(result.next, undefined);
});

test('macro writes refuse a configuration with a dangling key-to-macro reference', () => {
    const { config, baseline } = writeFixture(json => {
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 0, macroArguments: [] };
    });
    config.macros.shift();
    const state = { ...baseState, config, baseline, info: connected };
    const { result } = callMacroTool(state, 'create_macro', newMacro);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /would not serialize/i);
    assert.equal(result.next, undefined);
});

test('macro writes require a connected keyboard', () => {
    const { config, baseline } = writeFixture();
    const info = { ...connected, connected: false, model: null, firmwareVersion: null };
    for (const name of ['create_macro', 'update_macro', 'rename_macro', 'delete_macro']) {
        const { result } = callMacroTool({ ...baseState, config, baseline, info }, name, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /No keyboard is connected/);
        assert.equal(result.next, undefined);
    }
});

test('every MCP tool keeps text action contents hidden in successful and refused replies', () => {
    const original = 'synthetic-hidden-original 🔑';
    const replacement = 'synthetic-hidden-replacement';
    const createdText = 'synthetic-hidden-new';
    const { config, baseline, abbreviation } = writeFixture(json => {
        json.macros[0].name = 'Assigned';
        json.macros[0].macroActions = [{ macroActionType: 'text', text: original }];
        baseKeys(json)[27] = { keyActionType: 'playMacro', macroIndex: 0, macroArguments: [] };
    });
    const textAction = (text: string) => ({ macroActionType: 'text', text });
    let state = { ...baseState, config, baseline, info: connected, aiTags: [] };
    const call = (request: McpToolCall, isError = false) => {
        const result = handleMcpTool(state, request, false);
        for (const text of [original, replacement, createdText]) {
            assert.ok(!result.content[0].text.includes(text), `${request.name} exposed text action contents`);
        }
        assert.equal(result.isError, isError, request.name);
        if (result.next) {
            state = { ...state, ...result.next };
        }
        return result.content[0].text;
    };
    const location = { keymap: abbreviation, layer: 'base' };
    call({ name: 'get_device_info' });
    call({ name: 'list_keymaps' });
    call({ name: 'get_layer', arguments: location });
    call({ name: 'list_macros' });
    call({ name: 'get_macro', arguments: { name: 'Assigned' } });
    call({ name: 'get_macro_errors' });
    call({ name: 'set_key_action', arguments: { ...location, moduleId: 0, keyId: 28, action: { keyActionType: 'playMacro', macroIndex: 0 } } });
    call({ name: 'create_macro', arguments: { name: 'New text macro', macroActions: [textAction(createdText)] } });
    call({ name: 'update_macro', arguments: { name: 'Assigned', macroActions: [{ macroActionType: original }] } }, true);
    call({ name: 'update_macro', arguments: { name: 'Assigned', macroActions: [textAction(replacement)] } });
    call({ name: 'rename_macro', arguments: { name: 'Assigned', newName: 'Renamed' } });
    call({ name: 'delete_macro', arguments: { name: 'Renamed' } }, true);
    call({ name: 'delete_macro', arguments: { name: 'New text macro' } });
    assert.match(call({ name: 'get_unsaved_changes' }), /\[text macro, \d+ characters, hidden\]/);
});
