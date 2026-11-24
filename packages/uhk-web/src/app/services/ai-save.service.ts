import { inject, Injectable } from '@angular/core';
import { Actions, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { filter, firstValueFrom, map, merge, Observable, of, switchMap, take, takeUntil, timeout } from 'rxjs';
import { NotificationType, type McpToolReply } from 'uhk-common';

import { aiSaveRefusal, type AiSaveRefusal } from '../mcp/ai-save';
import { diffUserConfiguration, type UserConfigurationJson } from '../mcp/config-diff';
import {
    AppState, getKeyboardBaseline, getMcpDeviceInfo, getOutOfSpaceWaringData, getSaveBlock, getUserConfiguration, isBusyForSave,
} from '../store';
import { ShowNotificationAction } from '../store/actions/app';
import {
    ActionTypes, ConfigurationWriteStartedAction, SaveConfigurationAction, SaveToKeyboardSuccessAction, SaveToKeyboardSuccessFailed,
} from '../store/actions/device';

const KEYBOARD_ANSWER_TIMEOUT = 60_000;

interface SaveOutcome {
    result: 'saved' | 'failed' | 'unknown';
    message: string;
}

/** Saves to the keyboard for an AI client, if the user allows it and no change needs the user. */
@Injectable({ providedIn: 'root' })
export class AiSaveService {
    private readonly actions$ = inject(Actions);
    private readonly store = inject<Store<AppState>>(Store);
    private saving = false;

    async save(allowed: boolean): Promise<McpToolReply> {
        let checked: ReturnType<AiSaveService['check']>;
        try {
            checked = this.check(allowed);
        } catch {
            checked = { refusal: { message: 'Agent could not check the user configuration. Nothing was written.' }, changes: 0 };
        }
        const { refusal, changes } = checked;
        if (refusal) {
            return this.reply(refusal, true);
        }

        this.saving = true;
        try {
            const request = new SaveConfigurationAction(true);
            const outcome = firstValueFrom(this.outcome(request));
            this.store.dispatch(request);
            const { result, message } = await outcome;
            if (result !== 'saved') {
                return this.reply({ result, message }, true);
            }
            this.store.dispatch(new ShowNotificationAction({
                type: NotificationType.Info,
                message: `An AI client saved ${changes} ${changes === 1 ? 'change' : 'changes'} to the keyboard.`,
            }));
            return this.reply({ result, changes, message }, false);
        } finally {
            this.saving = false;
        }
    }

    private check(allowed: boolean): { refusal?: AiSaveRefusal; changes: number } {
        let state: AppState;
        this.store.pipe(take(1)).subscribe(current => state = current);
        const baseline = getKeyboardBaseline(state);
        const configuration: UserConfigurationJson = getUserConfiguration(state).toJsonObject();
        const refusal = aiSaveRefusal({
            allowed,
            info: getMcpDeviceInfo(state),
            baseline,
            configuration,
            busy: this.saving || isBusyForSave(state),
            outOfSpace: getOutOfSpaceWaringData(state).show,
            saveBlock: getSaveBlock(state),
        });
        return { refusal, changes: refusal ? 0 : diffUserConfiguration(baseline, configuration).length };
    }

    private outcome(request: SaveConfigurationAction): Observable<SaveOutcome> {
        const started$ = this.actions$.pipe(
            ofType<ConfigurationWriteStartedAction>(ActionTypes.ConfigurationWriteStarted),
            filter(({ payload }) => payload.request === request),
            take(1),
        );
        const failed$ = this.actions$.pipe(ofType<SaveToKeyboardSuccessFailed>(ActionTypes.SaveToKeyboardFailed));
        const notSent$ = failed$.pipe(
            takeUntil(started$),
            map((): SaveOutcome => ({ result: 'failed', message: 'Agent did not start the save. Nothing was written. Ask the user to save in Agent.' })),
        );
        // Other saves can finish in between, so match the configuration that this one sent.
        const answered$ = started$.pipe(switchMap(({ payload: { configuration } }) => merge(
            this.actions$.pipe(
                ofType<SaveToKeyboardSuccessAction>(ActionTypes.SaveToKeyboardSuccess),
                filter(({ payload }) => payload === configuration),
                map((): SaveOutcome => ({
                    result: 'saved', message: 'Saved to the keyboard. Ask the user to press the key to verify that it works, then call get_macro_errors.',
                })),
            ),
            failed$.pipe(
                filter(({ payload }) => payload?.configuration === configuration),
                map(({ payload }): SaveOutcome => ({
                    result: 'failed', message: `The save failed: ${payload.message} Some or all of the changes may have been written.`,
                })),
            ),
        )));
        return merge(answered$, notSent$).pipe(
            take(1),
            timeout({
                first: KEYBOARD_ANSWER_TIMEOUT,
                with: () => of<SaveOutcome>({
                    result: 'unknown', message: 'The keyboard did not answer in time. The save may or may not have reached the keyboard.',
                }),
            }),
        );
    }

    private reply(body: object, isError: boolean): McpToolReply {
        return { isError, content: [{ type: 'text', text: JSON.stringify(body) }] };
    }
}
