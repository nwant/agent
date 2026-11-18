import { Macro, TextMacroAction, CommandMacroAction, US_BASIC_SCANCODE_TEXTS, UHK_80_USER_CONFIG, UserConfiguration } from 'uhk-common';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcpTool, type McpDeviceInfo } from './tool-handler.js';

import { getDefaultQwertyKeyLabel } from '../util/get-default-key-label.js';

const defaultUserConfiguration = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
const keyLabel = (moduleId: number, keyId: number) => getDefaultQwertyKeyLabel({
    defaultUserConfiguration, moduleId, keyId,
    mapper: { scanCodeToText: code => US_BASIC_SCANCODE_TEXTS[code] || [String(code)] },
});
const emptyState = { config: new UserConfiguration(), keyLabel };
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

test('list_keymaps reads a renamed keymap and its layers from the current configuration', () => {
    const config = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    config.keymaps[0].name = 'Unsaved layout';
    const reply = handleMcpTool({ config, keyLabel }, { name: 'list_keymaps' });
    const [first] = JSON.parse(reply.content[0].text);
    assert.equal(first.name, 'Unsaved layout');
    assert.ok(first.layers.includes('base'));
});

test('get_layer returns physical labels and the serialized actions of the requested layer', () => {
    const config = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    const keymap = config.keymaps[0];
    const reply = handleMcpTool({ config, keyLabel }, {
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
        const reply = handleMcpTool({ config, keyLabel }, call, revealTextMacros);
        const actions = JSON.parse(reply.content[0].text).macroActions;
        assert.equal(actions[0].text === (revealTextMacros ? text : '[text macro, 4 characters, hidden]'), true);
        assert.equal(actions[1].command, command);
    }
});

test('list_macros only lists names and action types even when reveal is enabled', () => {
    const { config } = macroFixture();
    const reply = handleMcpTool({ config, keyLabel }, { name: 'list_macros' }, true);
    assert.deepEqual(JSON.parse(reply.content[0].text), [{ name: 'Mixed', actionTypes: ['text', 'command'] }]);
});

test('unknown names identify the failed lookup without echoing input', () => {
    const { config, text } = macroFixture();
    for (const [call, message] of [
        [{ name: 'get_macro', arguments: { name: text } }, /Unknown macro/],
        [{ name: 'get_layer', arguments: { keymap: text, layer: 'base' } }, /Unknown keymap/],
        [{ name: 'get_layer', arguments: { keymap: config.keymaps[0].name, layer: text } }, /Unknown layer/],
    ] as const) {
        const reply = handleMcpTool({ config, keyLabel }, call);
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
        { name: 'get_macro', arguments: { name: 'Mixed' } },
    ]) {
        const reply = handleMcpTool({ config, keyLabel, info }, call);
        assert.ok(!reply.isError);
        assert.equal(JSON.stringify(reply).includes(text), false);
    }
});

test('get_layer resolves the listed abbreviation when keymap names coincide', () => {
    const config = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    const [first, second] = config.keymaps;
    second.name = first.name;
    first.layers = [];
    const read = (keymap: string) => handleMcpTool({ config, keyLabel }, {
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
    const state = { config, keyLabel: () => 'Space' };

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
    const reply = handleMcpTool({ config, keyLabel }, { name: 'get_macro', arguments: { name: 'Mixed' } });
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0].text, 'Could not read the user configuration.');
});

test('short text actions preserve serializer vocabulary and full smart commands', () => {
    const { config, command } = macroFixture();
    (config.macros[0].macroActions[0] as TextMacroAction).text = 'e';
    const reply = handleMcpTool({ config, keyLabel }, { name: 'get_macro', arguments: { name: 'Mixed' } });
    const [typed, smart] = JSON.parse(reply.content[0].text).macroActions;
    assert.equal(typed.macroActionType, 'text');
    assert.equal(typed.text, '[text macro, 1 characters, hidden]');
    assert.equal(smart.command, command);
    const list = handleMcpTool({ config, keyLabel }, { name: 'list_macros' });
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
        const reply = handleMcpTool({ config, keyLabel, baseline, ...state }, { name: 'get_unsaved_changes' }, reveal);
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
    }]);
    assert.match((body as { summary: string }).summary, /^1 unsaved change\./);
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
        id: 'macro:AAA first', type: 'macro', name: 'AAA first', change: 'added', before: null, after: newMacro,
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
        { id: 'macro:Go to UHK site in browser', type: 'macro', name: 'Go to UHK site in browser', change: 'changed', before: changedBefore, after: changedAfter },
        { id: "macro:Type Silent Bob's address", type: 'macro', name: "Type Silent Bob's address", change: 'removed', before: removedBefore, after: null },
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

test('get_unsaved_changes reports an added keymap and each of its keys', () => {
    const { read } = unsavedFixture(json => {
        json.keymaps.push({ ...structuredClone(json.keymaps[0]), abbreviation: 'NEW', name: 'New' });
    });
    const changes = read().body.changes;
    const keymap = changes.find(change => change.id === 'other:keymaps.NEW');
    assert.equal(keymap.before, null);
    assert.equal(keymap.after.name, 'New');
    const keys = changes.filter(change => change.type === 'keyAction');
    assert.ok(keys.length > 0);
    assert.ok(keys.every(change => change.keymap === 'NEW' && change.before === null));
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
