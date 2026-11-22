import {
    ADVANCED_SECONDARY_ROLE_CONFIGURATION_FIELD_NAMES, BacklightingMode, BatteryChargingMode, ModuleId, NavigationMode, RgbColor,
    SecondaryRoleAdvancedStrategyTimeoutAction, SecondaryRoleAdvancedStrategyTimeoutType, SecondaryRoleAdvancedStrategyTriggeringEvent,
    SecondaryRoleStrategy, SIMPLE_ADVANCED_SECONDARY_ROLE_CONFIGURATION_PRESET, TouchpadDragStyle,
    type McpSettingsGroupName, type ModuleConfiguration, type UserConfiguration,
} from 'uhk-common';

import { isUhk80, SETTINGS_GROUPS, settingsGroupValues, type SettingsDevice } from './settings.js';

export class SettingsValidationError extends Error {}

type SettingRule = (value: unknown, path: string) => number | boolean | RgbColor;
type SettingRules<T> = {
    [K in keyof T as T[K] extends ReturnType<SettingRule> ? K : never]?: (value: unknown, path: string) => T[K];
};

function objectValue(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SettingsValidationError(`${path} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function numberInRange(min: number, max: number, integer = true) {
    return (value: unknown, path: string): number => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
            throw new SettingsValidationError(`${path} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
        }
        return value;
    };
}

function booleanValue(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') {
        throw new SettingsValidationError(`${path} must be a boolean.`);
    }
    return value;
}

function enumName(values: Record<string, string | number>) {
    const members = new Map(Object.entries(values).filter(([, value]) => typeof value === 'number'));
    return (value: unknown, path: string): number => {
        const member = typeof value === 'string' ? members.get(value) : undefined;
        if (typeof member !== 'number') {
            throw new SettingsValidationError(`${path} must be one of: ${[...members.keys()].join(', ')}.`);
        }
        return member;
    };
}

const byte = numberInRange(0, 255);
const mouseSpeed = numberInRange(1, 255);
const axisSkew = numberInRange(0.1, 10, false);
const typingTimeout = numberInRange(50, 1000);
const fadeTimeout = numberInRange(0, 3600);
const navigationMode = enumName(NavigationMode);

function rgbColor(value: unknown, path: string): RgbColor {
    const channels = objectValue(value, path);
    for (const name of Object.keys(channels)) {
        if (name !== 'r' && name !== 'g' && name !== 'b') {
            throw new SettingsValidationError(`Unknown color component ${path}.${name}.`);
        }
    }
    return new RgbColor({
        r: byte(channels.r, `${path}.r`),
        g: byte(channels.g, `${path}.g`),
        b: byte(channels.b, `${path}.b`),
    });
}

// Use the Device screens' limits in serializer units. The mouse movement sliders display raw values multiplied by 25.
const RULES: Record<Exclude<McpSettingsGroupName, 'modules' | 'connections'>, SettingRules<UserConfiguration>> = {
    typingBehavior: {
        secondaryRoleStrategy: enumName(SecondaryRoleStrategy),
        secondaryRoleAdvancedStrategyTimeout: typingTimeout,
        secondaryRoleAdvancedStrategySafetyMargin: numberInRange(-100, 100),
        secondaryRoleAdvancedStrategyTrigger: enumName(SecondaryRoleAdvancedStrategyTriggeringEvent),
        secondaryRoleAdvancedStrategyDoubletapToPrimary: booleanValue,
        secondaryRoleAdvancedStrategyTimeoutAction: enumName(SecondaryRoleAdvancedStrategyTimeoutAction),
        secondaryRoleAdvancedStrategyTriggerByMouse: booleanValue,
        secondaryRoleAdvancedStrategyTriggerFromSameHalf: booleanValue,
        secondaryRoleAdvancedStrategyMinimumHoldTime: byte,
        secondaryRoleAdvancedStrategyTimeoutType: enumName(SecondaryRoleAdvancedStrategyTimeoutType),
        doubletapTimeout: typingTimeout,
        keystrokeDelay: numberInRange(0, 50),
    },
    mouseKeySpeed: {
        mouseMoveInitialSpeed: mouseSpeed,
        mouseMoveAcceleration: mouseSpeed,
        mouseMoveDeceleratedSpeed: mouseSpeed,
        mouseMoveBaseSpeed: mouseSpeed,
        mouseMoveAcceleratedSpeed: mouseSpeed,
        mouseScrollInitialSpeed: mouseSpeed,
        mouseScrollAcceleration: mouseSpeed,
        mouseScrollDeceleratedSpeed: mouseSpeed,
        mouseScrollBaseSpeed: mouseSpeed,
        mouseScrollAcceleratedSpeed: mouseSpeed,
        mouseMoveAxisSkew: axisSkew,
        mouseScrollAxisSkew: axisSkew,
        diagonalSpeedCompensation: booleanValue,
    },
    led: {
        backlightingMode: enumName({
            FunctionalBacklighting: BacklightingMode.FunctionalBacklighting,
            PerKeyBacklighting: BacklightingMode.PerKeyBacklighting,
        }),
        backlightingNoneActionColor: rgbColor,
        backlightingScancodeColor: rgbColor,
        backlightingModifierColor: rgbColor,
        backlightingShortcutColor: rgbColor,
        backlightingSwitchLayerColor: rgbColor,
        backlightingSwitchKeymapColor: rgbColor,
        backlightingMouseColor: rgbColor,
        backlightingMacroColor: rgbColor,
        backlightingDeviceColor: rgbColor,
        keyBacklightBrightness: byte,
        keyBacklightFadeOutTimeout: fadeTimeout,
        displayBrightness: byte,
        displayFadeOutTimeout: fadeTimeout,
        keyBacklightBrightnessBattery: byte,
        keyBacklightFadeOutBatteryTimeout: fadeTimeout,
        displayBrightnessBattery: byte,
        displayFadeOutBatteryTimeout: fadeTimeout,
    },
    battery: {
        batteryChargingMode: enumName(BatteryChargingMode),
        keyBacklightBrightnessChargingDefault: numberInRange(0, 100),
    },
};

const moduleSpeed = numberInRange(0, 10, false);
const speedDivisor = numberInRange(1, 100);
const touchpadTimeout = numberInRange(0, 2000);

const MODULE_RULES: SettingRules<ModuleConfiguration> = {
    navigationModeBaseLayer: navigationMode,
    navigationModeModLayer: navigationMode,
    navigationModeFnLayer: navigationMode,
    navigationModeMouseLayer: navigationMode,
    navigationModeFn2Layer: navigationMode,
    navigationModeFn3Layer: navigationMode,
    navigationModeFn4Layer: navigationMode,
    navigationModeFn5Layer: navigationMode,
    speed: moduleSpeed,
    baseSpeed: moduleSpeed,
    xceleration: numberInRange(0, 2, false),
    scrollSpeedDivisor: speedDivisor,
    caretSpeedDivisor: speedDivisor,
    scrollAxisLock: booleanValue,
    caretAxisLock: booleanValue,
    axisLockFirstTickSkew: axisSkew,
    axisLockSkew: numberInRange(0.1, 1, false),
    invertScrollDirectionX: booleanValue,
    invertScrollDirectionY: booleanValue,
    angle: numberInRange(-180, 180, false),
};

const KEY_CLUSTER_RULES: SettingRules<ModuleConfiguration> = {
    ...MODULE_RULES,
    keyClusterSwapAxes: booleanValue,
};

const TOUCHPAD_RULES: SettingRules<ModuleConfiguration> = {
    ...MODULE_RULES,
    touchpadPinchZoomDivisor: numberInRange(1, 50),
    touchpadHoldContinuationTimeout: touchpadTimeout,
    touchpadPinchToZoom: enumName({
        Zoom: NavigationMode.Zoom,
        ZoomPc: NavigationMode.ZoomPc,
        ZoomMac: NavigationMode.ZoomMac,
        None: NavigationMode.None,
    }),
    touchpadDragStyle: enumName(TouchpadDragStyle),
    touchpadDoubleTapAndHoldTimeout: touchpadTimeout,
};

function parseValues(values: Record<string, unknown>, rules: Record<string, SettingRule>, path: string) {
    return Object.fromEntries(Object.entries(values).map(([name, value]) => {
        const field = `${path}.${name}`;
        if (!Object.prototype.hasOwnProperty.call(rules, name)) {
            throw new SettingsValidationError(`${field} is not an editable setting.`);
        }
        return [name, rules[name](value, field)] as const;
    }));
}

function applyModuleValues(config: UserConfiguration, values: Record<string, unknown>): void {
    for (const [id, value] of Object.entries(values)) {
        const module = config.moduleConfigurations.find(module => ModuleId[module.id] === id);
        const path = `modules.${id}`;
        if (!module) {
            throw new SettingsValidationError(`Unknown module ${path}. Use the IDs from get_settings.`);
        }
        const rules = module.id === ModuleId.TouchpadRight ? TOUCHPAD_RULES
            : module.id === ModuleId.KeyClusterLeft ? KEY_CLUSTER_RULES : MODULE_RULES;
        const updates = parseValues(objectValue(value, path), rules, path);
        Object.assign(module, updates);
        if (updates.touchpadDoubleTapAndHoldTimeout !== undefined
            && !(module.touchpadDragStyle & TouchpadDragStyle.DoubleTapAndHold)) {
            throw new SettingsValidationError(`${path}.touchpadDoubleTapAndHoldTimeout requires a drag style that enables double-tap and hold.`);
        }
    }
}

function validateTypingBehavior(config: UserConfiguration, updates: Record<string, ReturnType<SettingRule>>): void {
    const strategy = updates.secondaryRoleStrategy ?? config.secondaryRoleStrategy;
    if (strategy !== SecondaryRoleStrategy.Simple) {
        return;
    }

    const preset = SIMPLE_ADVANCED_SECONDARY_ROLE_CONFIGURATION_PRESET.configuration;
    const incompatible = ADVANCED_SECONDARY_ROLE_CONFIGURATION_FIELD_NAMES.filter(field =>
        (updates[field] ?? config[field]) !== preset[field]);
    if (incompatible.length) {
        throw new SettingsValidationError(
            `typingBehavior.${incompatible.join(', typingBehavior.')} would be reset by the Simple preset. Include the Simple preset values or use secondaryRoleStrategy Advanced.`,
        );
    }
}

export function proposeSettingsUpdate({ config, device, group, values }: {
    config: UserConfiguration;
    device: SettingsDevice;
    group: McpSettingsGroupName;
    values: unknown;
}) {
    if (group === 'connections') {
        throw new SettingsValidationError('connections is read-only. Change pairing, host connections and Bluetooth settings in Agent.');
    }

    const fields = objectValue(values, 'values');
    const { uhk80Only, uhk80Fields } = SETTINGS_GROUPS[group];
    if (!isUhk80(device)) {
        const unsupported = uhk80Only ? Object.keys(fields)[0] : Object.keys(fields).find(name => uhk80Fields?.includes(name));
        if (uhk80Only || unsupported) {
            const path = unsupported ? `${group}.${unsupported}` : group;
            const model = device.connected && device.model || 'the connected keyboard';
            throw new SettingsValidationError(`${path} is only available on UHK 80. Current model: ${model}.`);
        }
    }

    const next = config.clone();
    if (group === 'modules') {
        applyModuleValues(next, fields);
    } else {
        const updates = parseValues(fields, RULES[group], group);
        if (group === 'typingBehavior') {
            validateTypingBehavior(next, updates);
        }
        if (group === 'led' && updates.backlightingMode === BacklightingMode.PerKeyBacklighting) {
            next.perKeyRgbPresent = true;
        }
        Object.assign(next, updates);
    }
    return { config: next, values: settingsGroupValues(group, next.toJsonObject(), device) };
}
