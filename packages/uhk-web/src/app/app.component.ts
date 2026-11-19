import { AfterViewInit, Component, HostListener, OnDestroy, ChangeDetectorRef, TemplateRef, ViewChild, inject } from '@angular/core';
import { ActivatedRoute, Event, NavigationEnd, Router } from '@angular/router';
import { animate, style, transition, trigger } from '@angular/animations';
import { faPuzzlePiece, faArrowUp } from '@fortawesome/free-solid-svg-icons';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { Actions, ofType } from '@ngrx/effects';
import { SplitGutterInteractionEvent } from 'angular-split';
import { NotifierService } from 'gramli-angular-notifier';
import { EMPTY, map, merge, Observable, Subscription, switchMap, take } from 'rxjs';
import { Action, Store } from '@ngrx/store';
import { ERR_UPDATER_INVALID_SIGNATURE, LayerName, SharedConfigApplyData } from 'uhk-common';

import { RISK_FLAG_LABELS } from './mcp/risk-flag-labels';
import type { FlaggedConfigDiffEntry } from './mcp/risk-flags';
import { KeyboardSvgExportService } from './services/keyboard-svg-export.service';
import { MapperService } from './services/mapper.service';
import { SaveConfirmationService } from './services/save-confirmation.service';
import { SharedConfigService } from './services/shared-config.service';
import { ActionTypes as AppUpdateActionTypes } from './store/actions/app-update.action';
import { DoNotUpdateAppAction, UpdateAppAction } from './store/actions/app-update.action';
import { EnableUsbStackTestAction, UpdateFirmwareAction } from './store/actions/device';
import {
    AppState,
    getDonglePairingState,
    getHalvesPairingState,
    getNewPairedDevicesState,
    getErrorPanelHeight,
    getShowAppUpdateAvailable,
    getAppUpdateNotificationViewModel,
    getParsedStatusBuffer,
    deviceConfigurationLoaded,
    runningInElectron,
    saveToKeyboardState,
    keypressCapturing,
    firstAttemptOfSaveToKeyboard,
    isStatusBufferErrorHidden,
    getOutOfSpaceWaringData,
    getShowFirmwareUpgradePanel,
    getSharedConfigChange,
    getDefaultUserConfiguration,
    getUserConfiguration,
    showReviewChanges,
} from './store';
import { StartLeftHalfPairingAction } from './store/actions/advance-settings.action';
import { StartDonglePairingAction } from './store/actions/dongle-pairing.action';
import { AddNewPairedDevicesToHostConnectionsAction } from './store/actions/user-config';
import { ProgressButtonState } from './store/reducers/progress-button-state';
import { AppUpdateNotificationViewModel } from './models/app-update-notification-view-model';
import {
    CloseErrorPanelAction,
    ShowErrorPanelAction,
    ErrorPanelSizeChangedAction,
    KeyUpAction,
    KeyDownAction,
    ApplySharedConfigChangeAction,
    DismissSharedConfigChangeAction,
} from './store/actions/app';
import { BleAddingState, DonglePairingState, HalvesPairingState, OutOfSpaceWarningData } from './models';
import { filter } from 'rxjs/operators';
import { SecondSideMenuContainerComponent } from './components/side-menu';
import { formatMacroKeyAssignmentLabel } from './util/format-macro-key-assignment-label';

interface SaveConfirmationEntry {
    id: string;
    title: string;
    reasons: string[];
}

@Component({
    selector: 'main-app',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss'],
    standalone: false,
    animations: [
        trigger('showSaveToKeyboardButton', [
            transition(':enter', [
                style({transform: 'translateY(100%)'}),
                animate('400ms ease-in-out', style({transform: 'translateY(0)'}))
            ]),
            transition(':leave', [
                style({transform: 'translateY(0)'}),
                animate('400ms ease-in-out', style({transform: 'translateY(100%)'}))
            ])
        ]),
        trigger('showOutOfSpaceWarning', [
            transition(':enter', [
                style({transform: 'translateY(100%)'}),
                animate('400ms ease-in-out', style({transform: 'translateY(0)'}))
            ]),
            transition(':leave', [
                style({transform: 'translateY(0)'}),
                animate('400ms ease-in-out', style({transform: 'translateY(100%)'}))
            ])
        ]),
        trigger('topNotificationPanelVisible', [
            transition(':enter', [
                style({transform: 'translateY(-45px)'}),
                animate('500ms ease-out', style({transform: 'translateY(0)'}))
            ]),
            transition(':leave', [
                style({transform: 'translateY(0)'}),
                animate('500ms ease-out', style({transform: 'translateY(-45px)'}))
            ])
        ]),
        trigger('highlightArrow', [
            transition(':leave', [
                style({ opacity: 1 }),
                animate('500ms ease-out', style({ opacity: 0 }))
            ])
        ]),
        trigger('errorPanel', [
            transition(':leave', [
                style({ height: '*' }),
                animate('300ms ease-out', style({ height: 0 }))
            ])
        ]),
        trigger('slideInOut', [
            transition(':enter', [
                style({transform: 'translateX(100%)'}),
                animate('400ms ease-in-out', style({transform: 'translateX(0)'}))
            ]),
            transition(':leave', [
                style({transform: 'translateX(0)'}),
                animate('400ms ease-in-out', style({transform: 'translateX(100%)'}))
            ])
        ])
    ],
})
export class MainAppComponent implements AfterViewInit, OnDestroy {
    @ViewChild(SecondSideMenuContainerComponent) secondarySideMenuContainer: SecondSideMenuContainerComponent;
    @ViewChild('manuallyUpdateNotification', { static: true }) manuallyUpdateNotificationTmpl: TemplateRef<void>;
    @ViewChild('saveConfirmation', { static: true }) saveConfirmationTemplate: TemplateRef<unknown>;

    donglePairingState: DonglePairingState;
    halvesPairingState: HalvesPairingState;
    newPairedDevicesState: BleAddingState;
    showFirmwareUpgradePanel: boolean;
    showUpdateAvailable: boolean;
    appUpdateNotification$: Observable<AppUpdateNotificationViewModel>;
    deviceConfigurationLoaded$: Observable<boolean>;
    runningInElectron$: Observable<boolean>;
    saveToKeyboardState: ProgressButtonState;
    saveConfirmationEntries: SaveConfirmationEntry[] = [];
    firstAttemptOfSaveToKeyboard$: Observable<boolean>;
    isStatusBufferErrorHidden$: Observable<boolean>;
    outOfSpaceWarning: OutOfSpaceWarningData;
    sharedConfigChange: SharedConfigApplyData;
    secondSideMenuVisible = false;
    splitSizes = {
        top: 100,
        bottom: 0
    };
    statusBuffer: string;
    private readonly actions$ = inject(Actions);
    private actionsSubscription: Subscription;
    private readonly cdRef = inject(ChangeDetectorRef);
    private donglePairingStateSubscription: Subscription;
    private halvesPairingStateSubscription: Subscription;
    private newPairedDevicesStateSubscription: Subscription;
    private errorPanelHeightSubscription: Subscription;
    private readonly keyboardSvgExportService = inject(KeyboardSvgExportService);
    private readonly mapper = inject(MapperService);
    private readonly modal = inject(NgbModal);
    private readonly saveConfirmation = inject(SaveConfirmationService);
    private saveConfirmationModal?: NgbModalRef;
    private readonly sharedConfigService = inject(SharedConfigService);
    private keypressCapturing: boolean;
    private saveToKeyboardStateSubscription: Subscription;
    private keypressCapturingSubscription: Subscription;
    private readonly notificationService = inject(NotifierService);
    private showFirmwareUpgradePanelSubscription: Subscription;
    private sharedConfigChangeSubscription: Subscription;
    private showUpdateAvailableSubscription: Subscription;
    private outOfSpaceWarningSubscription: Subscription;
    private routeDataSubscription: Subscription;
    private statusBufferSubscription: Subscription;
    private secondSideMenuComponent: unknown;
    private readonly store = inject<Store<AppState>>(Store);
    readonly showReviewChanges$ = this.store.select(showReviewChanges);
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);

    constructor() {
        this.actionsSubscription = this.actions$.pipe(
            ofType(AppUpdateActionTypes.InvalidCodesignSignature)
        )
        .subscribe(() => {
            this.notificationService.show({
                message: '',
                type: 'info',
                template: this.manuallyUpdateNotificationTmpl,
                id: ERR_UPDATER_INVALID_SIGNATURE,
            })
        })

        this.donglePairingStateSubscription = this.store.select(getDonglePairingState)
            .subscribe(data => {
                this.donglePairingState = data;
                this.cdRef.markForCheck();
            });
        this.halvesPairingStateSubscription = this.store.select(getHalvesPairingState)
            .subscribe(data => {
                this.halvesPairingState = data;
                this.cdRef.markForCheck();
            });
        this.newPairedDevicesStateSubscription = this.store.select(getNewPairedDevicesState)
            .subscribe(data => {
                this.newPairedDevicesState = data;
                this.cdRef.markForCheck();
            });
        this.errorPanelHeightSubscription = this.store.select(getErrorPanelHeight)
            .subscribe(height => {
                this.splitSizes = {
                    top: 100 - height,
                    bottom: height
                };
                this.cdRef.markForCheck();
            });
        this.showFirmwareUpgradePanelSubscription = this.store.select(getShowFirmwareUpgradePanel)
            .subscribe(data => {
                this.showFirmwareUpgradePanel = data;
                this.cdRef.markForCheck();
            });
        this.sharedConfigChangeSubscription = this.store.select(getSharedConfigChange)
            .subscribe(data => {
                this.sharedConfigChange = data;
                this.cdRef.markForCheck();
            });
        this.showUpdateAvailableSubscription = this.store.select(getShowAppUpdateAvailable)
            .subscribe(data => {
                this.showUpdateAvailable = data;
                this.cdRef.markForCheck();
            });
        this.appUpdateNotification$ = this.store.select(getAppUpdateNotificationViewModel);
        this.deviceConfigurationLoaded$ = this.store.select(deviceConfigurationLoaded);
        this.runningInElectron$ = this.store.select(runningInElectron);
        this.saveToKeyboardStateSubscription = this.store.select(saveToKeyboardState)
            .subscribe(data => this.saveToKeyboardState = data);
        this.keypressCapturingSubscription = this.store.select(keypressCapturing)
            .subscribe(data => this.keypressCapturing = data);
        this.firstAttemptOfSaveToKeyboard$ = this.store.select(firstAttemptOfSaveToKeyboard);
        this.isStatusBufferErrorHidden$ = this.store.select(isStatusBufferErrorHidden);
        this.outOfSpaceWarningSubscription = this.store.select(getOutOfSpaceWaringData)
            .subscribe(data => this.outOfSpaceWarning = data);
        this.routeDataSubscription = this.router.events.pipe(
            filter((event: Event) => event instanceof NavigationEnd)
        ).subscribe((event: NavigationEnd) => {
            let tmpRoute = this.route.snapshot.root;
            let data = { ...tmpRoute.data };

            while (tmpRoute.firstChild) {
                tmpRoute = tmpRoute.firstChild;
                data = {
                    ...data,
                    ...tmpRoute.data
                };
            }

            if (this.secondSideMenuComponent !== data.secondMenuComponent) {
                this.secondSideMenuComponent = data.secondMenuComponent;

                if (this.secondSideMenuComponent) {
                    this.secondSideMenuVisible = true;
                    this.secondarySideMenuContainer.resolveComponent(this.secondSideMenuComponent);
                } else {
                    this.secondSideMenuVisible = false;
                    this.secondarySideMenuContainer.clear();
                }
                this.cdRef.detectChanges();
            }
        });
        this.statusBufferSubscription = this.store.select(getParsedStatusBuffer)
            .subscribe(data => {
                this.statusBuffer = data;
                this.cdRef.markForCheck();
            });
    }

    ngAfterViewInit(): void {
        this.saveConfirmation.registerReview(changes => this.reviewConfigurationWrite(changes));
    }

    ngOnDestroy(): void {
        this.saveConfirmation.unregisterReview();
        this.saveConfirmationModal?.dismiss();
        this.actionsSubscription.unsubscribe();
        this.donglePairingStateSubscription.unsubscribe();
        this.halvesPairingStateSubscription.unsubscribe();
        this.newPairedDevicesStateSubscription.unsubscribe();
        this.errorPanelHeightSubscription.unsubscribe();
        this.saveToKeyboardStateSubscription.unsubscribe();
        this.keypressCapturingSubscription.unsubscribe();
        this.showFirmwareUpgradePanelSubscription.unsubscribe();
        this.sharedConfigChangeSubscription.unsubscribe();
        this.showUpdateAvailableSubscription.unsubscribe();
        this.outOfSpaceWarningSubscription.unsubscribe();
        this.routeDataSubscription.unsubscribe();
        this.statusBufferSubscription.unsubscribe();
    }

    @HostListener('document:keydown', ['$event'])
    onKeyDown(event: KeyboardEvent) {
        // It should be before the CTRL + S to prevent the conflict with the SaveToKeyboard shortcut
        if (event.ctrlKey &&
            event.shiftKey &&
            event.key === 'S' &&
            !event.defaultPrevented &&
            !this.keypressCapturing) {
            this.keyboardSvgExportService.downloadSvgKeyboard();
            event.preventDefault();
        }

        if (this.saveToKeyboardState.showButton &&
            event.ctrlKey &&
            event.key === 's' &&
            !event.defaultPrevented &&
            !this.keypressCapturing) {
            if (this.saveToKeyboardState.action) {
                this.clickedOnProgressButton(this.saveToKeyboardState.action);
            }
            event.preventDefault();
        }

        if (event.shiftKey &&
            event.ctrlKey &&
            event.metaKey &&
            event.key === '|' &&
            !event.defaultPrevented) {
            this.enableUsbStackTest();
            event.preventDefault();
        }

        this.store.dispatch(new KeyDownAction(event));
    }

    errorPanelSizeDragEndHandler($event: SplitGutterInteractionEvent) {
        this.store.dispatch(new ErrorPanelSizeChangedAction($event.sizes[1] as number));
    }

    @HostListener('document:keyup', ['$event'])
    onKeyUp(event: KeyboardEvent) {
        this.store.dispatch(new KeyUpAction(event));
    }

    addPairedDevicesToHostConnections() {
        this.store.dispatch(new AddNewPairedDevicesToHostConnectionsAction());
    }

    closeErrorPanel(): void {
        this.store.dispatch(new CloseErrorPanelAction());
    }

    dismissUpdateErrorNotification(): void {
        this.notificationService.hide(ERR_UPDATER_INVALID_SIGNATURE);
    }

    showErrorPanel(): void {
        this.store.dispatch(new ShowErrorPanelAction());
    }

    updateApp() {
        this.store.dispatch(new UpdateAppAction());
    }

    doNotUpdateApp() {
        this.store.dispatch(new DoNotUpdateAppAction());
    }

    clickedOnProgressButton(action: Action): void {
        if (!this.saveConfirmationModal) {
            this.store.dispatch(action);
        }
    }

    private reviewConfigurationWrite(changes: FlaggedConfigDiffEntry[]): Observable<boolean> {
        if (document.visibilityState !== 'visible' || this.modal.hasOpenModals()) {
            return EMPTY;
        }

        return this.store.pipe(take(1), switchMap(state => {
            const config = getUserConfiguration(state);
            const defaultUserConfiguration = getDefaultUserConfiguration(state);
            this.saveConfirmationEntries = changes.map(change => {
                const reasons = change.riskFlags.map(flag => RISK_FLAG_LABELS[flag]);
                if (change.type !== 'keyAction') {
                    const title = change.type === 'other' ? change.path : change.name;
                    return { id: change.id, title, reasons };
                }

                const keymap = config.keymaps.find(keymap => keymap.abbreviation === change.keymap);
                const title = formatMacroKeyAssignmentLabel({
                    keymapName: keymap?.name || change.keymap,
                    layerId: LayerName[change.layer as keyof typeof LayerName],
                    moduleId: change.moduleId,
                    keyId: change.keyId,
                    defaultUserConfiguration,
                    mapper: this.mapper,
                });
                return { id: change.id, title, reasons };
            });

            const modal = this.modal.open(this.saveConfirmationTemplate, {
                ariaLabelledBy: 'save-confirmation-title',
                scrollable: true,
            });
            this.saveConfirmationModal = modal;
            modal.hidden.subscribe(() => this.saveConfirmationModal = undefined);
            return merge(modal.closed.pipe(map(() => true)), modal.dismissed.pipe(map(() => false)));
        }));
    }

    enableUsbStackTest() {
        this.store.dispatch(new EnableUsbStackTestAction());
    }

    isTopNotificationPanelVisible(): boolean {
        return this.showFirmwareUpgradePanel
            || this.showUpdateAvailable
            || this.donglePairingState?.showDonglePairingPanel
            || this.halvesPairingState?.showHalvesPairingPanel
            || this.newPairedDevicesState?.showNewPairedDevicesPanel
            || !!this.sharedConfigChange;
    }

    applySharedConfigChange(): void {
        this.sharedConfigService.acknowledge(this.sharedConfigChange?.content);
        this.store.dispatch(new ApplySharedConfigChangeAction());
    }

    dismissSharedConfigChange(): void {
        this.sharedConfigService.acknowledge(this.sharedConfigChange?.content);
        this.store.dispatch(new DismissSharedConfigChangeAction());
    }

    updateFirmware(): void {
        this.store.dispatch(new UpdateFirmwareAction(false));
    }

    startHalvesPairing(): void {
        this.store.dispatch(new StartLeftHalfPairingAction());
    }

    startDonglePairing(): void {
        this.store.dispatch(new StartDonglePairingAction());
    }

    protected readonly faPuzzlePiece = faPuzzlePiece;
    protected readonly faArrowUp = faArrowUp;
}
