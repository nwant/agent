import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UserConfigurationJson } from './config-diff.js';
import { aiSaveRefusal, findChangesNeedingUser, type AiSaveState } from './ai-save.js';
import type { McpDeviceInfo } from './tool-handler.js';

const macro = (name: string, ...commands: string[]) => ({
    name, macroActions: commands.map(command => ({ macroActionType: 'command', command })),
});
const configuration = (...macros: Array<ReturnType<typeof macro>>): UserConfigurationJson => ({ keymaps: [], macros });
const needing = (before: UserConfigurationJson, after: UserConfigurationJson) =>
    findChangesNeedingUser(before, after).map(({ id, reasons }) => [id, ...reasons]);

const baseline = configuration(macro('Plain', 'write old'));
const changed = configuration(macro('Plain', 'write new'));
const ready: AiSaveState = {
    allowed: true, info: { connected: true, model: 'UHK 80', firmwareVersion: '18.0.3', halves: { left: true, right: true, merged: false } },
    baseline, configuration: changed, busy: false, outOfSpace: false, saveBlock: undefined,
};

test('a ready keyboard with ordinary changes can be saved', () => {
    assert.equal(aiSaveRefusal(ready), undefined);
});

for (const [name, change, message] of [
    ['the setting is off', { allowed: false }, /Let AI clients save to the keyboard/],
    ['keyboard information is loading', { info: undefined as McpDeviceInfo }, /still loading/],
    ['no keyboard is connected', { info: { ...ready.info, connected: false } }, /Connect a keyboard/],
    ['Agent is busy', { busy: true }, /busy/],
    ['the keyboard configuration is unknown', { baseline: undefined as UserConfigurationJson }, /does not know/],
    ['there are no changes', { configuration: baseline }, /no unsaved changes/i],
    ['the firmware must be updated', { saveBlock: 'firmwareUpgrade' }, /firmware/],
    ['there are too many host connections', { saveBlock: 'hostConnections' }, /connections/],
    ['the configuration is too new', { saveBlock: 'configurationVersion' }, /too new/],
    ['the changes do not fit', { outOfSpace: true }, /space/],
    ['a change needs the user', { configuration: configuration(macro('$onInit', 'set x 1')) }, /Review/],
] as const) {
    test(`an AI save is refused when ${name}`, () => {
        assert.match(aiSaveRefusal({ ...ready, ...change }).message, message);
    });
}

test('the setting is checked before anything about the keyboard is told', () => {
    assert.match(aiSaveRefusal({ ...ready, allowed: false, info: undefined, baseline: undefined }).message, /Let AI clients save/);
});

test('a refusal for changes needing the user names them', () => {
    const refusal = aiSaveRefusal({ ...ready, configuration: configuration(macro('$onInit', 'set x 1')) });
    assert.deepEqual(refusal.changes, [{ id: 'macro:$onInit', reasons: ['runsWithoutKeyPress'] }]);
});

test('launcher and lockout changes need the user, and other flags do not', () => {
    assert.deepEqual(needing(configuration(), configuration(
        macro('Launch', 'tapKey LG-space'), macro('Lock', 'resetConfiguration'),
        macro('Type', 'write hello'), macro('Dynamic', 'tapKey $x'), macro('Setting', 'set a 1'),
    )), [['macro:Launch', 'opensLauncherOrShell'], ['macro:Lock', 'lockout']]);
});

for (const command of ['call', 'exec', 'fork']) {
    test(`a macro an event macro starts with ${command} needs the user`, () => {
        const event = macro('$onInit', `${command} Helper`);
        assert.deepEqual(needing(configuration(event, macro('Helper', 'write a'), macro('Other', 'write a')),
            configuration(event, macro('Helper', 'write b'), macro('Other', 'write b'))), [['macro:Helper', 'calledByEventMacro']]);
    });
}

test('an added macro that an event macro already calls needs the user', () => {
    const event = macro('$onLayerChange fn', 'call Helper');
    assert.deepEqual(needing(configuration(event), configuration(event, macro('Helper', 'write b'))), [['macro:Helper', 'calledByEventMacro']]);
});

test('macros reached through other macros need the user, and call cycles end', () => {
    const event = macro('$onInit', 'call One');
    const one = macro('One', 'call Two');
    assert.deepEqual(needing(configuration(event, one, macro('Two', 'call One')), configuration(event, one, macro('Two', 'call One', 'write b'))),
        [['macro:Two', 'calledByEventMacro']]);
});

test('every macro with the called name is followed, even when names repeat', () => {
    const event = macro('$onInit', 'call Twin');
    const macros = [event, macro('Twin', 'write a'), macro('Twin', 'call Two')];
    assert.deepEqual(needing(configuration(...macros, macro('Two', 'write a')), configuration(...macros, macro('Two', 'write b'))),
        [['macro:Two', 'calledByEventMacro']]);
});

for (const line of [
    'if ($a == 1) call Helper', 'ifShortcut a final call Helper', '{ call Helper', 'label: call Helper', 'if ($a) { call Helper }',
    'if ($a) {call Helper}', 'else fork Helper // comment',
]) {
    test(`a call is found in: ${line}`, () => {
        const event = macro('$onInit', `write a\n    ${line}`);
        assert.deepEqual(needing(configuration(event, macro('Helper', 'write a')), configuration(event, macro('Helper', 'write b'))),
            [['macro:Helper', 'calledByEventMacro']]);
    });
}

for (const line of ['write "please call Helper"', "write 'call Helper'", '// call Helper', 'write a // call Helper', 'playMacro Helper']) {
    test(`nothing is called in: ${line}`, () => {
        const event = macro('$onInit', line);
        assert.deepEqual(needing(configuration(event, macro('Helper', 'write a')), configuration(event, macro('Helper', 'write b'))), []);
    });
}

for (const line of ['call $name', 'call &macroArg.1', '&macroArg.1', 'call "Helper"', 'call', 'if ($a) exec $(b)']) {
    test(`every macro change needs the user after an unknown call: ${line}`, () => {
        const event = macro('$onInit', line);
        assert.deepEqual(needing(configuration(event, macro('A', 'write a'), macro('B', 'write b')), configuration(event, macro('A', 'write c'))), [
            ['macro:A', 'eventMacroCallUnknown'], ['macro:B', 'eventMacroCallUnknown'],
        ]);
    });
}

test('an unknown call in a macro no event macro reaches changes nothing', () => {
    const helper = macro('Helper', 'call $name');
    assert.deepEqual(needing(configuration(helper, macro('A', 'write a')), configuration(helper, macro('A', 'write b'))), []);
});

test('an event macro kept on the keyboard but removed in Agent is not followed', () => {
    assert.deepEqual(needing(configuration(macro('$onInit', 'call A'), macro('A', 'write a')), configuration(macro('A', 'write b'))), []);
});
