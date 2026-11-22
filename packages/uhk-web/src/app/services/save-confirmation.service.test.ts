import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BehaviorSubject, EMPTY, firstValueFrom, of, Subject } from 'rxjs';
import type { UserConfigurationJson } from '../mcp/config-diff.js';
import { getSaveConfirmationChanges, SaveConfirmationService } from './save-confirmation.service.js';

const baseline: UserConfigurationJson = { keymaps: [], macros: [] };
const eventMacro = { name: '$onInit', macroActions: [{ macroActionType: 'delay', delay: 10 }] };
const routineMacro = { name: 'Routine', macroActions: [{ macroActionType: 'text', text: 'fixture' }] };
const launcherKeymap = {
    name: 'Launcher keymap', abbreviation: 'LCH', isDefault: true,
    layers: [{ id: 'base', modules: [{ id: 0, keyActions: [
        { keyActionType: 'keystroke', type: 'basic', scancode: 21, modifierMask: 8 },
    ] }] }],
};
const pending = getSaveConfirmationChanges(baseline, { ...baseline, macros: [eventMacro] });

test('only the two qualifying flags require a review of pending changes', () => {
    const current = { keymaps: [launcherKeymap], macros: [routineMacro, eventMacro] };
    assert.deepEqual(getSaveConfirmationChanges(baseline, current).map(({ id, riskFlags }) => ({ id, riskFlags })), [
        { id: 'keymap:LCH', riskFlags: ['opensLauncherOrShell'] },
        { id: 'macro:$onInit', riskFlags: ['runsWithoutKeyPress'] },
    ]);
    assert.deepEqual(getSaveConfirmationChanges(current, current), []);
});

test('an unknown keyboard baseline still checks macros and key bindings in a restore candidate', () => {
    const current = { keymaps: [launcherKeymap], macros: [eventMacro] };
    assert.deepEqual(getSaveConfirmationChanges(undefined, current).map(change => change.id), ['keymap:LCH', 'macro:$onInit']);
    assert.deepEqual(getSaveConfirmationChanges(undefined, { ...baseline, macros: [routineMacro] }), []);
});

test('routine changes can proceed without a presenter', async () => {
    const service = new SaveConfirmationService();
    assert.equal(await firstValueFrom(service.authorize([], EMPTY)), 'approved');
});

test('flagged changes require review if the presenter is absent, unavailable, or fails', async () => {
    const service = new SaveConfirmationService();
    const approve = () => firstValueFrom(service.authorize(pending, of(true)));
    assert.equal(await approve(), 'reviewRequired');
    service.registerReview(() => EMPTY);
    assert.equal(await approve(), 'reviewRequired');
    service.registerReview(() => { throw new Error('Dialog unavailable'); });
    assert.equal(await approve(), 'reviewRequired');
});

test('confirmation from a replaced presenter requires a new review even when the configuration is current', async () => {
    const service = new SaveConfirmationService();
    const original = new Subject<boolean>();
    service.registerReview(() => original);
    const approval = firstValueFrom(service.authorize(pending, of(true)));

    service.registerReview(() => of(true));
    original.next(true);
    assert.equal(await approval, 'reviewRequired');
    assert.equal(await firstValueFrom(service.authorize(pending, of(true))), 'approved');
});

test('one explicit response applies to one current request', async () => {
    const service = new SaveConfirmationService();
    const response = new Subject<boolean>();
    const stillCurrent = new BehaviorSubject(true);
    service.registerReview(changes => {
        assert.deepEqual(changes.map(change => change.id), ['macro:$onInit']);
        return response;
    });

    const approve = () => firstValueFrom(service.authorize(pending, stillCurrent));
    const first = approve();
    assert.equal(await approve(), 'reviewRequired');
    response.next(false);
    assert.equal(await first, 'cancelled');

    const stale = approve();
    stillCurrent.next(false);
    response.next(true);
    assert.equal(await stale, 'reviewRequired');

    stillCurrent.next(true);
    const confirmed = approve();
    response.next(true);
    assert.equal(await confirmed, 'approved');
});
