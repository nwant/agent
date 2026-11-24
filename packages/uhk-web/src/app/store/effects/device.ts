import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { ROUTER_NAVIGATED, ROUTER_NAVIGATION, RouterNavigatedAction} from '@ngrx/router-store';
import { Action, Store } from '@ngrx/store';
import { isEqual } from 'lodash';
import { EMPTY, of, timer } from 'rxjs';
import { distinctUntilChanged, map, mergeMap, pairwise, switchMap, tap, withLatestFrom } from 'rxjs/operators';

import {
    FirmwareUpgradeIpcResponse,
    getHardwareConfigFromDeviceResponse,
    HardwareConfiguration,
    IpcResponse,
    NotificationType,
    shouldUpgradeFirmware,
    UdevRulesInfo,
    UHK_60_DEVICE,
    UHK_60_V2_DEVICE,
    UHK_80_DEVICE,
    UHK_DEVICE_IDS,
} from 'uhk-common';

import {
    ActionTypes,
    AutomaticSavePausedAction,
    ChangeDeviceAction,
    ChangeKeyboardLayoutAction,
    ChangeKeyboardLayoutReplyAction,
    CheckAreHostConnectionsPairedAction,
    CheckAreHostConnectionsPairedReplyAction,
    ConnectionStateChangedAction,
    ConfigurationWriteRequest,
    ConfigurationWriteStartedAction,
    EnableUsbStackTestAction,
    EraseBleSettingReplyAction,
    ExecShellCommandOnDongleAction,
    ExecShellCommandOnLeftHalfAction,
    ExecShellCommandOnRightHalfAction,
    HideSaveToKeyboardButton,
    ReadConfigSizesAction,
    RecoveryDeviceReplyAction,
    RecoveryModuleAction,
    RestoreUserConfigurationFromBackupSuccessAction,
    SaveConfigurationAction,
    SaveConfigurationReplyAction,
    SaveToKeyboardSuccessAction,
    SaveToKeyboardSuccessFailed,
    SetPrivilegeOnLinuxReplyAction,
    SkipFirmwareUpgradeAction,
    StartConnectionPollerAction,
    UpdateFirmwareFailedAction,
    UpdateFirmwareNotSupportedAction,
    UpdateFirmwareReplyAction,
    UpdateFirmwareSuccessAction,
} from '../actions/device';
import {
    EmptyAction,
    LoadHardwareConfigurationSuccessAction,
    SetupPermissionErrorAction,
    ShowNotificationAction
} from '../actions/app';
import {
    ActionTypes as DongleActions,
} from '../actions/dongle-pairing.action';
import {
    AppState,
    deviceConnected,
    getAiTags,
    getConnectedDevice,
    getHardwareConfiguration,
    getHostConnections,
    getKeyboardBaseline,
    getMcpDeviceInfo,
    getRouterState,
    getSaveBlock,
    getUserConfiguration,
    isUserConfigLoading,
    runningInElectron,
} from '../index';
import {
    ActionTypes as UserConfigActions,
    ApplyUserConfigurationFromFileAction,
    LoadConfigFromDeviceAction,
    LoadResetUserConfigurationAction
} from '../actions/user-config';
import { AppRendererService } from '../../services/app-renderer.service';
import { DefaultUserConfigurationService } from '../../services/default-user-configuration.service';
import { DeviceRendererService } from '../../services/device-renderer.service';
import { getSaveConfirmationChanges, SaveConfirmationService } from '../../services/save-confirmation.service';
import { DataStorageRepositoryService } from '../../services/datastorage-repository.service';
import { RouterState } from '../router-util';
import type { UserConfigurationJson } from '../../mcp/config-diff';

@Injectable()
export class DeviceEffects {
    private readonly actions$ = inject(Actions);
    private readonly appRendererService = inject(AppRendererService);
    private readonly dataStorageRepository = inject(DataStorageRepositoryService);
    private readonly defaultUserConfigurationService = inject(DefaultUserConfigurationService);
    private readonly deviceRendererService = inject(DeviceRendererService);
    private readonly saveConfirmation = inject(SaveConfirmationService);
    private readonly router = inject(Router);
    private readonly store = inject<Store<AppState>>(Store);
    // Serialized configurations of saves in flight, oldest first. Each becomes the keyboard baseline when its save succeeds.
    private readonly sentConfigurations: UserConfigurationJson[] = [];

    changeDevice$ = createEffect(() => this.actions$
        .pipe(
            ofType<RouterNavigatedAction<RouterState>>(ROUTER_NAVIGATION),
            map(action => action.payload.routerState.queryParams.device),
            distinctUntilChanged(),
            map(device => {
                if (device === 'uhk60') {
                    return new ChangeDeviceAction(UHK_60_DEVICE);
                }

                if (device === 'uhk80') {
                    return new ChangeDeviceAction(UHK_80_DEVICE);
                }

                return new EmptyAction()
            })
        )
    );

    changeKeyboardLayout$ = createEffect(() => this.actions$
        .pipe(
            ofType<ChangeKeyboardLayoutAction>(ActionTypes.ChangeKeyboardLayout),
            withLatestFrom(this.store.select(getHardwareConfiguration)),
            tap(([action, hardwareConfiguration]) => {
                this.deviceRendererService.changeKeyboardLayout(action.layout, hardwareConfiguration);
            })
        ),
    {dispatch:false}
    );

    changeKeyboardLayoutFailed$ = createEffect(() => this.actions$
        .pipe(
            ofType<ChangeKeyboardLayoutReplyAction>(ActionTypes.ChangeKeyboardLayoutReply),
            map(action => {
                if (action.payload.success) {
                    return new LoadHardwareConfigurationSuccessAction(getHardwareConfigFromDeviceResponse(action.payload.hardwareConfig));
                }

                return new ShowNotificationAction({
                    message: action.payload.error?.message,
                    type: NotificationType.Error,
                });
            })
        )
    );

    checkAreHostConnectionsPaired$ = createEffect(() => this.actions$
        .pipe(
            ofType(ActionTypes.CheckAreHostConnectionsPaired, DongleActions.DonglePairingSuccess),
            withLatestFrom(this.store.select(getConnectedDevice), this.store.select(getHostConnections)),
            tap(([_, connectedDevice, hostConnections]) => {
                if (connectedDevice?.id === UHK_60_DEVICE.id || connectedDevice?.id === UHK_60_V2_DEVICE.id) {
                    return
                }

                const addresses: string[] = [];
                for (const hostConnection of hostConnections) {
                    if (hostConnection.hasAddress()) {
                        addresses.push(hostConnection.address);
                    }
                }

                this.deviceRendererService.areBleAddressesPaired(addresses);
            }),
        ),
    { dispatch: false },
    );

    checkAreHostConnectionsPairedReply$ = createEffect(() => this.actions$
        .pipe(
            ofType<CheckAreHostConnectionsPairedReplyAction>(ActionTypes.CheckAreHostConnectionsPairedReply),
            map(action => action.payload),
            switchMap(response => {
                if (response.success) {
                    return EMPTY;
                }

                return of(new ShowNotificationAction({
                    message: response.error?.message,
                    type: NotificationType.Error,
                }));
            })
        )
    );

    deviceConnectionStateChange$ = createEffect(() => this.actions$
        .pipe(
            ofType<ConnectionStateChangedAction>(ActionTypes.ConnectionStateChanged),
            withLatestFrom(
                this.store.select(getRouterState),
                this.store.select(deviceConnected),
            ),
            tap(([action, route, connected]) => {
                const state = action.payload;

                if (route.state && route.state.url.startsWith('/device/firmware')) {
                    return;
                }

                if (state.multiDevice) {
                    this.router.navigate(['/multi-device']);
                    return;
                }

                if (!state.hasPermission || state.udevRulesInfo === UdevRulesInfo.Different) {
                    this.router.navigate(['/privilege']);
                    return;
                }

                if (state.bootloaderActive || state.leftHalfBootloaderActive || state.dongle.bootloaderActive) {
                    this.router.navigate(['/recovery-device']);
                    return;
                }

                if (shouldUpgradeFirmware(state.hardwareModules?.rightModuleInfo?.userConfigVersion)) {
                    this.router.navigate(['/update-firmware']);
                    return;
                }

                if (state.connectedDevice && state.communicationInterfaceAvailable) {
                    const allowDefaultNavigation = [
                        '/detection',
                        '/privilege',
                        '/loading'
                    ].some(start => route.state.url.startsWith(start));

                    if (allowDefaultNavigation) {
                        this.router.navigate(['/']);
                        return;
                    }

                    return;
                }

                this.router.navigate(['/detection']);
            }),
            distinctUntilChanged((
                [prevAction, prevRoute, prevConnected],
                [currAction, currRoute, currConnected]) => {

                return prevConnected === currConnected &&
                    prevAction.payload.hasPermission === currAction.payload.hasPermission &&
                    prevAction.payload.communicationInterfaceAvailable === currAction.payload.communicationInterfaceAvailable;
            }),
            mergeMap(([action, route, connected]) => {
                const payload = action.payload;

                if (connected
                    && payload.hasPermission
                    && payload.communicationInterfaceAvailable) {

                    const result: Array<Action> = [
                        new ReadConfigSizesAction(),
                        new LoadConfigFromDeviceAction(),
                    ];

                    return result;
                }

                return EMPTY;
            })
        )
    );

    eraseBleSettings$ = createEffect(() => this.actions$
        .pipe(
            ofType(ActionTypes.EraseBleSettings),
            tap(() => {
                this.deviceRendererService.eraseBleSettings();
            }),
        ),
    { dispatch: false },
    );

    eraseBleSettingsReply$ = createEffect(() => this.actions$
        .pipe(
            ofType<EraseBleSettingReplyAction>(ActionTypes.EraseBleSettingsReply),
            map(action => action.payload),
            switchMap(response => {
                if (response.success) {
                    return of(new CheckAreHostConnectionsPairedAction());
                }

                return of(new ShowNotificationAction({
                    type: NotificationType.Error,
                    message: response.error.message
                }));
            })
        ),
    );

    execShellCommandOnDongle$ = createEffect(() => this.actions$
        .pipe(
            ofType<ExecShellCommandOnDongleAction>(ActionTypes.ExecShellCommandOnDongle),
            tap((action) => {
                this.deviceRendererService.execShellCommandOnDongle(action.payload);
            })
        ),
        { dispatch: false }
    );

    execShellCommandOnLeftHalf$ = createEffect(() => this.actions$
            .pipe(
                ofType<ExecShellCommandOnLeftHalfAction>(ActionTypes.ExecShellCommandOnLeftHalf),
                tap((action) => {
                    this.deviceRendererService.execShellCommandOnLeftHalf(action.payload);
                })
            ),
        { dispatch: false }
    );

    execShellCommandOnRightHalf$ = createEffect(() => this.actions$
            .pipe(
                ofType<ExecShellCommandOnRightHalfAction>(ActionTypes.ExecShellCommandOnRightHalf),
                tap((action) => {
                    this.deviceRendererService.execShellCommandOnRightHalf(action.payload);
                })
            ),
        { dispatch: false }
    );

    setPrivilegeOnLinux$ = createEffect(() => this.actions$
        .pipe(
            ofType(ActionTypes.SetPrivilegeOnLinux),
            tap(() => {
                this.deviceRendererService.setPrivilegeOnLinux();
            })
        ),
    { dispatch: false }
    );

    setPrivilegeOnLinuxReply$ = createEffect(() => this.actions$
        .pipe(
            ofType<SetPrivilegeOnLinuxReplyAction>(ActionTypes.SetPrivilegeOnLinuxReply),
            map(action => action.payload),
            switchMap((response) => {
                if (response.success) {
                    this.appRendererService.getAppStartInfo();
                    return EMPTY;
                }

                return of(new SetupPermissionErrorAction(response.error.message));
            })
        )
    );

    approveConfigurationWrite$ = createEffect(() => this.actions$
        .pipe(
            ofType<ConfigurationWriteRequest>(
                ActionTypes.SaveConfiguration, ActionTypes.UpdateFirmware, ActionTypes.UpdateFirmwareWith, ActionTypes.RecoveryDevice,
            ),
            withLatestFrom(this.store),
            mergeMap(([request, state]) => {
                const isSave = request.type === ActionTypes.SaveConfiguration;
                const userConfig = getUserConfiguration(state);
                const saveBlock = isSave ? getSaveBlock(state) : undefined;
                if (saveBlock === 'firmwareUpgrade') {
                    this.router.navigate(['/update-firmware']);
                    return [new SaveToKeyboardSuccessFailed()];
                }

                if (saveBlock === 'hostConnections') {
                    this.router.navigate(['/device/host-connections']);
                    return [new SaveToKeyboardSuccessFailed()];
                }

                if (saveBlock === 'configurationVersion') {
                    const firmwareUserConfigVersion = state.device.modules.rightModuleInfo?.userConfigVersion;
                    return [
                        new ShowNotificationAction({
                            type: NotificationType.Error,
                            message: `The user configuration version (${userConfig.getSemanticVersion()}) is too high for this firmware (supports up to ${firmwareUserConfigVersion}). Please update the firmware or use a compatible configuration.`
                        }),
                        new SaveToKeyboardSuccessFailed()
                    ];
                }

                const hardwareConfig = getHardwareConfiguration(state);
                const configuration: UserConfigurationJson = userConfig.toJsonObject();
                const startWrite = new ConfigurationWriteStartedAction({ request, configuration, hardwareConfig });
                const writesUserConfig = request.type !== ActionTypes.RecoveryDevice
                    || (request.payload !== UHK_DEVICE_IDS.UHK80_LEFT && request.payload !== UHK_DEVICE_IDS.UHK_DONGLE);
                if (!runningInElectron(state) || !writesUserConfig) {
                    return of(startWrite);
                }

                if (request.type === ActionTypes.SaveConfiguration && request.automatic && getAiTags(state).length) {
                    return [
                        new AutomaticSavePausedAction(),
                        new ShowNotificationAction({
                            type: NotificationType.Warning,
                            message: 'The connection change is not saved yet. Review the unsaved changes, which include AI-tagged changes, then save to keyboard.',
                        }),
                    ];
                }

                const baseline = getKeyboardBaseline(state);
                const changes = getSaveConfirmationChanges(baseline, configuration);
                const stillCurrent$ = this.store.pipe(map(current =>
                    getConnectedDevice(current)?.id === getConnectedDevice(state)?.id
                    && getHardwareConfiguration(current) === hardwareConfig
                    && getKeyboardBaseline(current) === baseline
                    && !isUserConfigLoading(current)
                    && (!isSave || Boolean(getMcpDeviceInfo(current)?.connected))
                    && isEqual(getUserConfiguration(current).toJsonObject(), configuration),
                ));

                return this.saveConfirmation.authorize(changes, stillCurrent$).pipe(mergeMap(approval => {
                    if (approval === 'approved') {
                        return [startWrite];
                    }
                    const actions: Action[] = isSave ? [new SaveToKeyboardSuccessFailed()] : [];
                    if (approval === 'reviewRequired') {
                        actions.push(new ShowNotificationAction({
                            type: NotificationType.Warning,
                            message: 'Review the unsaved changes in Agent before saving to the keyboard.',
                        }));
                    }
                    return actions;
                }));
            })
        )
    );

    writeConfiguration$ = createEffect(() => this.actions$.pipe(
        ofType<ConfigurationWriteStartedAction>(ActionTypes.ConfigurationWriteStarted),
        tap(({ payload: { request, configuration, hardwareConfig } }) => {
            switch (request.type) {
                case ActionTypes.SaveConfiguration:
                    setTimeout(() => this.sendUserConfigToKeyboard(configuration, hardwareConfig, request.payload), 100);
                    break;
                case ActionTypes.UpdateFirmware:
                    this.deviceRendererService.updateFirmware({ userConfig: configuration, forceUpgrade: request.payload });
                    break;
                case ActionTypes.UpdateFirmwareWith:
                    this.deviceRendererService.updateFirmware({
                        userConfig: configuration,
                        forceUpgrade: request.payload.forceUpgrade,
                        uploadFile: request.payload.uploadFileData,
                    });
                    break;
                case ActionTypes.RecoveryDevice:
                    this.deviceRendererService.recoveryDevice({ userConfig: configuration, deviceId: request.payload });
                    break;
            }
        }),
    ), { dispatch: false });

    saveConfigurationReply$ = createEffect(() => this.actions$
        .pipe(
            ofType<SaveConfigurationReplyAction>(ActionTypes.SaveConfigurationReply),
            map(action => action.payload),
            mergeMap((response: IpcResponse) => {
                const sentConfiguration = this.sentConfigurations.shift();
                if (response.success) {
                    return [
                        new SaveToKeyboardSuccessAction(sentConfiguration)
                    ];
                }

                return [
                    new ShowNotificationAction({
                        type: NotificationType.Error,
                        message: response.error.message
                    }),
                    new SaveToKeyboardSuccessFailed({ configuration: sentConfiguration, message: response.error.message })
                ];
            })
        )
    );

    autoHideSaveToKeyboardButton$ = createEffect(() => this.actions$
        .pipe(
            ofType(ActionTypes.SaveToKeyboardSuccess),
            withLatestFrom(this.store),
            switchMap(([action, state]) => timer(1000)
                .pipe(
                    mergeMap(() => {
                        const actions = [new HideSaveToKeyboardButton()];

                        if (state.device.restoreUserConfiguration) {
                            actions.push(new RestoreUserConfigurationFromBackupSuccessAction());
                            this.router.navigate(['/']);
                        }

                        return actions;
                    })
                )
            )
        )
    );

    resetMouseSpeedSettings$ = createEffect(() => this.actions$
        .pipe(
            ofType(
                ActionTypes.ResetPcMouseSpeedSettings,
                ActionTypes.ResetMacMouseSpeedSettings
            ),
            withLatestFrom(this.store.select(getUserConfiguration)),
            map(([action, config]) => new LoadResetUserConfigurationAction(config))
        )
    );

    resetUserConfiguration$ = createEffect(() => this.actions$
        .pipe(
            ofType(ActionTypes.ResetUserConfiguration),
            withLatestFrom(this.store.select(getConnectedDevice), this.store.select(getUserConfiguration)),
            switchMap(([, uhkDeviceProduct, currentUserConfiguration]) => {
                const config = this.defaultUserConfigurationService.getResetUserConfiguration(uhkDeviceProduct);
                // The keyboard name belongs to the keyboard rather than to the configuration,
                // so a factory reset must not replace it with the default name.
                config.deviceName = currentUserConfiguration.deviceName || config.deviceName;

                return of(new LoadResetUserConfigurationAction(config));
            })
        )
    );

    saveResetUserConfigurationToDevice$ = createEffect(() => this.actions$
        .pipe(
            ofType<LoadResetUserConfigurationAction>(UserConfigActions.LoadResetUserConfiguration),
            withLatestFrom(this.store.select(getConnectedDevice)),
            switchMap(([action, uhkDeviceProduct]) => this.dataStorageRepository.saveConfig(action.payload, uhkDeviceProduct)
                .pipe(
                    map(() => new SaveConfigurationAction(true))
                )
            )
        )
    );

    applyUserConfigurationFromFileAction$ = createEffect(() => this.actions$
        .pipe(
            ofType<ApplyUserConfigurationFromFileAction>(UserConfigActions.ApplyUserConfigurationFromFile),
            withLatestFrom(this.store.select(getConnectedDevice)),
            switchMap(([action, uhkDeviceProduct]) => this.dataStorageRepository.saveConfig(action.payload.userConfig, uhkDeviceProduct)
                .pipe(
                    map(() => new SaveConfigurationAction(action.payload.saveInHistory))
                )
            )
        )
    );

    updateFirmwareReply$ = createEffect(() => this.actions$
        .pipe(
            ofType<UpdateFirmwareReplyAction>(ActionTypes.UpdateFirmwareReply),
            map(action => action.payload),
            switchMap((response: FirmwareUpgradeIpcResponse) => {

                if (response.success) {
                    return of(new UpdateFirmwareSuccessAction({
                        firmwareDowngraded: response.firmwareDowngraded,
                        userConfigSaved: response.userConfigSaved
                    }));
                }

                if (response.failReason) {
                    return of(new UpdateFirmwareNotSupportedAction(response.failReason));
                }

                return of(new UpdateFirmwareFailedAction({
                    error: response.error,
                }));
            })
        )
    );

    restoreUserConfiguration$ = createEffect(() => this.actions$
        .pipe(
            ofType(ActionTypes.RestoreConfigurationFromBackup),
            map(() => new SaveConfigurationAction(true))
        )
    );

    recoveryDeviceReply$ = createEffect(() => this.actions$
        .pipe(
            ofType<RecoveryDeviceReplyAction>(ActionTypes.RecoveryDeviceReply),
            map(action => action.payload),
            mergeMap((response: FirmwareUpgradeIpcResponse) => {

                if (response.success) {
                    return [
                        new UpdateFirmwareSuccessAction({
                            firmwareDowngraded: response.firmwareDowngraded,
                            userConfigSaved: response.userConfigSaved
                        }),
                        new StartConnectionPollerAction()
                    ];
                }

                return [
                    new UpdateFirmwareFailedAction({
                        error: response.error,
                    })
                ];
            })
        )
    );

    recoveryModule$ = createEffect(() => this.actions$
        .pipe(
            ofType<RecoveryModuleAction>(ActionTypes.RecoveryModule),
            map(action => action.payload),
            tap(moduleId => this.deviceRendererService.recoveryModule(moduleId))
        ),
    { dispatch: false }
    );

    enableUsbStackTest$ = createEffect(() => this.actions$
        .pipe(
            ofType<EnableUsbStackTestAction>(ActionTypes.EnableUsbStackTest),
            tap(() => this.deviceRendererService.enableUsbStackTest())
        ),
    { dispatch: false }
    );

    startConnectionPoller$ = createEffect(() => this.actions$
        .pipe(
            ofType(ActionTypes.StartConnectionPoller),
            tap(() => this.deviceRendererService.startConnectionPoller())
        ),
    { dispatch: false }
    );

    readConfigSizes$ = createEffect(() => this.actions$
        .pipe(
            ofType(ActionTypes.ReadConfigSizes),
            tap(() => this.deviceRendererService.readConfigSizes())
        ),
    { dispatch: false }
    );

    skipFirmwareUpgrade$ = createEffect(() => this.actions$
        .pipe(
            ofType<RouterNavigatedAction>(ROUTER_NAVIGATED),
            map<RouterNavigatedAction, string>(action => action?.payload?.routerState?.url),
            pairwise(),
            map(([prevUrl]) => {
                if (prevUrl?.startsWith('/update-firmware'))
                    return new SkipFirmwareUpgradeAction();

                return new EmptyAction();
            })
        )
    );

    private sendUserConfigToKeyboard(
        configuration: UserConfigurationJson,
        hardwareConfig: HardwareConfiguration,
        saveInHistory: boolean): void {
        this.sentConfigurations.push(configuration);
        this.deviceRendererService.saveUserConfiguration({
            saveInHistory,
            deviceId: hardwareConfig && hardwareConfig.deviceId,
            uniqueId: hardwareConfig && hardwareConfig.uniqueId,
            configuration,
        });
    }
}
