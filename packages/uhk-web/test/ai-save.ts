import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { Actions } from '@ngrx/effects';
import { Action, Store } from '@ngrx/store';
import { createMockStore } from '@ngrx/store/testing';
import { merge, Subject } from 'rxjs';
import { IpcResponse, Macro, SaveUserConfigurationData, UHK_80_DEVICE, UHK_80_USER_CONFIG, UserConfiguration } from 'uhk-common';

import type { UserConfigurationJson } from '../src/app/mcp/config-diff';
import { AiSaveService } from '../src/app/services/ai-save.service';
import { AppRendererService } from '../src/app/services/app-renderer.service';
import { DataStorageRepositoryService } from '../src/app/services/datastorage-repository.service';
import { DefaultUserConfigurationService } from '../src/app/services/default-user-configuration.service';
import { DeviceRendererService } from '../src/app/services/device-renderer.service';
import { SaveConfirmationService } from '../src/app/services/save-confirmation.service';
import { DongleOperations } from '../src/app/models';
import {
    ConfigurationWriteStartedAction, SaveConfigurationAction, SaveConfigurationReplyAction, SaveToKeyboardSuccessAction,
    SaveToKeyboardSuccessFailed,
} from '../src/app/store/actions/device';
import { DeviceEffects } from '../src/app/store/effects/device';

export const actions = { SaveToKeyboardSuccessAction, SaveToKeyboardSuccessFailed };

/** An AI save of one added macro, with the store and the actions that answer it under the test's control. */
export function setupAiSave(change: { device?: object; app?: object; dongle?: object; firmware?: object; advanceSettings?: object; unserializable?: boolean } = {}) {
    const userConfiguration = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG));
    const keyboardBaseline: UserConfigurationJson = userConfiguration.toJsonObject();
    userConfiguration.macros = [...userConfiguration.macros, Object.assign(new Macro(), { id: 200, name: 'Added by AI', macroActions: [] })];
    if (change.unserializable) {
        userConfiguration.toJsonObject = () => { throw new Error('unserializable'); };
    }
    const store = createMockStore({ initialState: {
        app: { runningInElectron: true, configLoading: false, ...change.app },
        device: {
            deviceConnectionStateLoaded: true, connectedDevice: UHK_80_DEVICE, hasPermission: true, communicationInterfaceAvailable: true,
            halvesInfo: {}, modules: { rightModuleInfo: { userConfigVersion: userConfiguration.getSemanticVersion() } },
            saveToKeyboard: { showProgress: false }, configSizes: { userConfig: 1_000_000 }, skipFirmwareUpgrade: false, ...change.device,
        },
        userConfiguration: { userConfiguration, keyboardBaseline, aiTags: [] },
        dongle: { operation: DongleOperations.None, ...change.dongle },
        firmware: { ...change.firmware },
        advanceSettings: { isLeftHalfPairing: false, ...change.advanceSettings },
    } });
    const actions$ = new Subject<Action>();
    const dispatched: Action[] = [];
    store.dispatch = ((action: Action) => { dispatched.push(action); }) as typeof store.dispatch;
    const sent: SaveUserConfigurationData[] = [];
    const injector = Injector.create({ providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: Store, useValue: store },
        SaveConfirmationService,
        { provide: DeviceRendererService, useValue: { saveUserConfiguration: (data: SaveUserConfigurationData) => sent.push(data) } },
        ...[AppRendererService, DataStorageRepositoryService, DefaultUserConfigurationService, Router].map(provide => ({ provide, useValue: {} })),
    ] });
    const service = runInInjectionContext(injector, () => new AiSaveService());
    return {
        dispatched,
        save: (allowed = true) => service.save(allowed),
        emit: (action: Action) => actions$.next(action),
        /** The save path approves the request and sends the configuration it returns. */
        start: (request = dispatched[0] as SaveConfigurationAction) => {
            const configuration: UserConfigurationJson = userConfiguration.toJsonObject();
            actions$.next(new ConfigurationWriteStartedAction({ request, configuration, hardwareConfig: undefined }));
            return configuration;
        },
        sent,
        /** Runs the dispatched actions through Agent's own save effects. */
        connectSaveEffects: () => {
            const effects = runInInjectionContext(injector, () => new DeviceEffects());
            merge(effects.approveConfigurationWrite$, effects.saveConfigurationReply$).subscribe(action => actions$.next(action));
            effects.writeConfiguration$.subscribe();
            store.dispatch = ((action: Action) => { dispatched.push(action); actions$.next(action); }) as typeof store.dispatch;
        },
        answerFromKeyboard: (response: IpcResponse) => actions$.next(new SaveConfigurationReplyAction(response)),
        otherRequest: () => new SaveConfigurationAction(true),
    };
}
