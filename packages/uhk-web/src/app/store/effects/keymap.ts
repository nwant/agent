import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { map, pairwise, tap, withLatestFrom } from 'rxjs/operators';

import { Keymap } from 'uhk-common';
import { findNewItem } from '../../util';
import * as Keymaps from '../actions/keymap';
import { ActionTypes as UserConfigActionTypes } from '../actions/user-config';
import { AppState, getKeymaps, getRouterState, getSelectedKeymap } from '../index';

@Injectable()
export class KeymapEffects {
    private readonly actions$ = inject(Actions);
    private readonly router = inject(Router);
    private readonly store = inject<Store<AppState>>(Store);

    addOrDuplicate$ = createEffect(() => this.actions$
        .pipe(
            ofType(Keymaps.ActionTypes.Add, Keymaps.ActionTypes.Duplicate),
            withLatestFrom(this.store.select(getKeymaps)
                .pipe(
                    pairwise()
                )
            ),
            map(([action, latest]) => latest),
            tap(([prevKeymaps, newKeymaps]) => {
                const newKeymap = findNewItem(prevKeymaps, newKeymaps);
                this.router.navigate(['/keymap', newKeymap.abbreviation], { queryParamsHandling: 'merge' });
            })
        ),
    { dispatch: false }
    );

    remove$ = createEffect(() => this.actions$
        .pipe(
            ofType(Keymaps.ActionTypes.Remove),
            withLatestFrom(this.store.select(getKeymaps)),
            map(latest => latest[1]),
            tap(keymaps => {
                if (keymaps.length === 0) {
                    this.router.navigate(['/keymap/add']);
                } else {
                    const favourite: Keymap = keymaps.find(keymap => keymap.isDefault);
                    this.router.navigate(['/keymap', favourite.abbreviation], { queryParamsHandling: 'merge' });
                }
            })
        ),
    { dispatch: false }
    );

    // An AI write keeps the screen unless it removed the keymap on it; the reducer has already chosen what to show instead.
    followKeymapAfterAiWrite$ = createEffect(() => this.actions$
        .pipe(
            ofType(UserConfigActionTypes.ApplyAiUserConfiguration),
            withLatestFrom(this.store.select(getRouterState), this.store.select(getKeymaps), this.store.select(getSelectedKeymap)),
            tap(([, router, keymaps, selected]) => {
                const shown = router?.state?.pathname.startsWith('/keymap/') ? router.state.params.abbr as string : undefined;
                // selected is empty only in a configuration with no keymaps, where there is nowhere to go.
                if (shown && selected && !keymaps.some(keymap => keymap.abbreviation === decodeURIComponent(shown))) {
                    this.router.navigate(['/keymap', selected.abbreviation], { queryParamsHandling: 'merge' });
                }
            })
        ),
    { dispatch: false }
    );

    editAbbr$ = createEffect(() => this.actions$
        .pipe(
            ofType(Keymaps.ActionTypes.EditAbbr),
            withLatestFrom(this.store.select(getKeymaps)),
            tap(([action, keymaps]: [Keymaps.EditKeymapAbbreviationAction, Keymap[]]) => {
                for (const keymap of keymaps) {
                    if (keymap.name === action.payload.name && keymap.abbreviation === action.payload.newAbbr) {
                        this.router.navigate(['/keymap', action.payload.newAbbr], { queryParamsHandling: 'merge' });
                        return;
                    }
                }
            })
        ),
    { dispatch: false }
    );
}
