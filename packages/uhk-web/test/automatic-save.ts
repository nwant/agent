import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { Actions } from '@ngrx/effects';
import { Action, Store } from '@ngrx/store';
import { createMockStore } from '@ngrx/store/testing';
import { firstValueFrom, Observable, of, toArray } from 'rxjs';
import { LogService } from 'uhk-common';

import { DataStorageRepositoryService } from '../src/app/services/datastorage-repository.service';
import { DefaultUserConfigurationService } from '../src/app/services/default-user-configuration.service';
import { DeviceRendererService } from '../src/app/services/device-renderer.service';
import { FileDialogService } from '../src/app/services/file-dialog.service';
import { Uhk80MigratorService } from '../src/app/services/uhk80-migrator.service';
import { SaveToKeyboardSuccessFailed, AutomaticSavePausedAction } from '../src/app/store/actions/device';
import {
    DeleteHostConnectionAction, DeleteHostConnectionSuccessAction, DonglePairingSuccessAction, StartDonglePairingAction,
} from '../src/app/store/actions/dongle-pairing.action';
import { AddNewPairedDevicesToHostConnectionsAction } from '../src/app/store/actions/user-config';
import { DonglePairingEffect } from '../src/app/store/effects/dongle-pairing.effect';
import { UserConfigEffects } from '../src/app/store/effects/user-config';
import * as fromDevice from '../src/app/store/reducers/device';
import * as fromDongle from '../src/app/store/reducers/dongle-pairing.reducer';
import * as fromUserConfig from '../src/app/store/reducers/user-configuration';

export const reducers = { device: fromDevice, dongle: fromDongle, userConfig: fromUserConfig };
export const actions = {
    AutomaticSavePausedAction, DeleteHostConnectionAction, DeleteHostConnectionSuccessAction, DonglePairingSuccessAction,
    SaveToKeyboardSuccessFailed, StartDonglePairingAction,
};

async function run<T>(action: Action, effectsClass: new () => T, select: (effects: T) => Observable<Action>): Promise<Action[]> {
    const injector = Injector.create({ providers: [
        { provide: Actions, useValue: new Actions(of(action)) },
        { provide: Store, useValue: createMockStore({ initialState: {} }) },
        ...[
            DataStorageRepositoryService, DefaultUserConfigurationService, DeviceRendererService, FileDialogService, LogService, Router,
            Uhk80MigratorService,
        ].map(provide => ({ provide, useValue: {} })),
    ] });
    try {
        const effects = runInInjectionContext(injector, () => new effectsClass());
        return await firstValueFrom(select(effects).pipe(toArray()));
    } finally {
        injector.destroy();
    }
}

export const automaticSaves = {
    'adding newly paired Bluetooth devices': () =>
        run(new AddNewPairedDevicesToHostConnectionsAction(), UserConfigEffects, effects => effects.addNewPairedDevives$),
    'deleting a host connection': () =>
        run(new DeleteHostConnectionSuccessAction({ index: 0, address: '' }), DonglePairingEffect, effects => effects.deleteHostConnectionSuccess$),
    'pairing a dongle': () =>
        run(new DonglePairingSuccessAction(''), DonglePairingEffect, effects => effects.donglePairingSuccess$),
};
