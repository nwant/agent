import { mock } from 'node:test';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { Actions } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { createMockStore } from '@ngrx/store/testing';
import { firstValueFrom, of, toArray } from 'rxjs';
import type { UserConfiguration } from 'uhk-common';

import { ApplyAiUserConfigurationAction } from '../src/app/store/actions/user-config';
import { KeymapEffects } from '../src/app/store/effects/keymap';

export async function followKeymapAfterAiWrite({ shown, userConfiguration, selectedKeymapAbbr }: {
    shown: string | undefined; userConfiguration: UserConfiguration; selectedKeymapAbbr: string | undefined;
}) {
    const pathname = shown ? `/keymap/${shown}` : '/macro';
    const store = createMockStore({ initialState: {
        router: { state: { url: pathname, pathname, params: shown ? { abbr: shown } : {}, queryParams: {} } },
        userConfiguration: { userConfiguration, selectedKeymapAbbr },
    } });
    const navigate = mock.fn();
    const action = new ApplyAiUserConfigurationAction({ userConfiguration, aiTags: [] });
    const injector = Injector.create({ providers: [
        { provide: Actions, useValue: new Actions(of(action)) },
        { provide: Store, useValue: store },
        { provide: Router, useValue: { navigate } },
    ] });
    try {
        const effects = runInInjectionContext(injector, () => new KeymapEffects());
        await firstValueFrom(effects.followKeymapAfterAiWrite$.pipe(toArray()));
        return navigate;
    } finally {
        injector.destroy();
    }
}
