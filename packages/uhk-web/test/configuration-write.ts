import { mock } from 'node:test';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { Actions } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { createMockStore } from '@ngrx/store/testing';
import { firstValueFrom, of, toArray } from 'rxjs';
import { UHK_80_USER_CONFIG, UserConfiguration } from 'uhk-common';

import { AppRendererService } from '../src/app/services/app-renderer.service';
import { DataStorageRepositoryService } from '../src/app/services/datastorage-repository.service';
import { DefaultUserConfigurationService } from '../src/app/services/default-user-configuration.service';
import { DeviceRendererService } from '../src/app/services/device-renderer.service';
import { SaveConfirmationService } from '../src/app/services/save-confirmation.service';
import type { ConfigurationWriteRequest } from '../src/app/store/actions/device';
import { DeviceEffects } from '../src/app/store/effects/device';

export async function runRequest(request: ConfigurationWriteRequest, {
    userConfig = new UserConfiguration().fromJsonObject(structuredClone(UHK_80_USER_CONFIG)),
    electron = true, skipFirmwareUpgrade = false, firmwareConfigVersion = userConfig.getSemanticVersion(), aiTags = [],
}: {
    userConfig?: UserConfiguration; electron?: boolean; skipFirmwareUpgrade?: boolean; firmwareConfigVersion?: string; aiTags?: string[];
} = {}) {
    const store = createMockStore({ initialState: {
        app: { runningInElectron: electron },
        device: { skipFirmwareUpgrade, modules: { rightModuleInfo: { userConfigVersion: firmwareConfigVersion } } },
        userConfiguration: { userConfiguration: userConfig, aiTags },
    } });
    const authorize = mock.fn(() => of('approved'));
    const navigate = mock.fn();
    const injector = Injector.create({ providers: [
        { provide: Actions, useValue: new Actions(of(request)) },
        { provide: Store, useValue: store },
        { provide: Router, useValue: { navigate } },
        { provide: SaveConfirmationService, useValue: { authorize } },
        ...[AppRendererService, DataStorageRepositoryService, DefaultUserConfigurationService, DeviceRendererService]
            .map(provide => ({ provide, useValue: {} })),
    ] });
    try {
        const effects = runInInjectionContext(injector, () => new DeviceEffects());
        const emitted = await firstValueFrom(effects.approveConfigurationWrite$.pipe(toArray()));
        return { emitted, types: emitted.map(action => action.type), navigate, authorize };
    } finally {
        injector.destroy();
    }
}
