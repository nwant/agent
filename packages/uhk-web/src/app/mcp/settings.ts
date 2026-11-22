import { MCP_SETTINGS_GROUP_NAMES, UHK_80_DEVICE, type McpSettingsGroupName } from 'uhk-common';

import type { UserConfigurationJson } from './config-diff.js';

interface SettingsGroup {
    /** The Agent Device screen under /device, or null for modules, which have one screen each. */
    page: string | null;
    /** Top-level fields of the serializer's JSON shape. */
    fields: readonly string[];
    /** Fields shown only on the UHK 80. */
    uhk80Fields?: readonly string[];
    uhk80Only?: boolean;
    setCommand: string;
}

const LED_BATTERY_FIELDS = [
    'keyBacklightBrightnessBattery', 'keyBacklightFadeOutBatteryTimeout', 'displayBrightnessBattery', 'displayFadeOutBatteryTimeout',
];

// Fields are grouped as the Device screens edit them. doubleTapSwitchLayerTimeout, the advanced doubletap timeout and
// perKeyRgbPresent sit on no screen; they join the group whose screen the proposed-changes list links them to.
export const SETTINGS_GROUPS: Record<McpSettingsGroupName, SettingsGroup> = {
    typingBehavior: {
        page: 'typing-behavior',
        fields: [
            'secondaryRoleStrategy', 'secondaryRoleAdvancedStrategyDoubletapTimeout', 'secondaryRoleAdvancedStrategyTimeout',
            'secondaryRoleAdvancedStrategySafetyMargin', 'secondaryRoleAdvancedStrategyTrigger',
            'secondaryRoleAdvancedStrategyDoubletapToPrimary', 'secondaryRoleAdvancedStrategyTimeoutAction',
            'secondaryRoleAdvancedStrategyTriggerByMouse', 'secondaryRoleAdvancedStrategyTriggerFromSameHalf',
            'secondaryRoleAdvancedStrategyMinimumHoldTime', 'secondaryRoleAdvancedStrategyTimeoutType',
            'doubletapTimeout', 'doubleTapSwitchLayerTimeout', 'keystrokeDelay',
        ],
        setCommand: 'set secondaryRole.*, set doubletapTimeout and set keystrokeDelay',
    },
    mouseKeySpeed: {
        page: 'mouse-key-speed',
        fields: [
            'mouseMoveInitialSpeed', 'mouseMoveAcceleration', 'mouseMoveDeceleratedSpeed', 'mouseMoveBaseSpeed', 'mouseMoveAcceleratedSpeed',
            'mouseScrollInitialSpeed', 'mouseScrollAcceleration', 'mouseScrollDeceleratedSpeed', 'mouseScrollBaseSpeed',
            'mouseScrollAcceleratedSpeed', 'mouseMoveAxisSkew', 'mouseScrollAxisSkew', 'diagonalSpeedCompensation',
        ],
        setCommand: 'set mouseKeys.* and set diagonalSpeedCompensation',
    },
    led: {
        page: 'led-settings',
        fields: [
            'perKeyRgbPresent', 'backlightingMode', 'backlightingNoneActionColor', 'backlightingScancodeColor', 'backlightingModifierColor',
            'backlightingShortcutColor', 'backlightingSwitchLayerColor', 'backlightingSwitchKeymapColor', 'backlightingMouseColor',
            'backlightingMacroColor', 'backlightingDeviceColor', 'keyBacklightBrightness', 'keyBacklightFadeOutTimeout',
            'displayBrightness', 'displayFadeOutTimeout', ...LED_BATTERY_FIELDS,
        ],
        uhk80Fields: LED_BATTERY_FIELDS,
        setCommand: 'set backlight.* and set leds.*',
    },
    battery: {
        page: 'battery-settings',
        fields: ['batteryChargingMode', 'keyBacklightBrightnessChargingDefault'],
        uhk80Only: true,
        setCommand: 'set battery.chargeLimit (read back as `$battery.chargeLimit`, it is 1 or 0, not a name)',
    },
    connections: {
        page: 'host-connections',
        fields: ['hostConnections', 'bluetoothAlwaysAdvertise', 'bluetoothKeepConnectionsAlive'],
        uhk80Only: true,
        setCommand: 'set bluetooth.*',
    },
    modules: {
        page: null,
        fields: ['moduleConfigurations'],
        setCommand: 'set module.MODULEID.*, where MODULEID is keycluster (KeyClusterLeft), trackball (TrackballRight), trackpoint (TrackpointRight) or touchpad (TouchpadRight)',
    },
};

/** The Device screen that edits a top-level setting; the Configuration screen for one no other screen shows. */
export function settingsPage(path: string): string {
    return Object.values(SETTINGS_GROUPS).find(group => group.fields.includes(path))?.page ?? 'configuration';
}

const RUNTIME_NOTE = 'A smart-macro `set` command, for example in $onInit, changes the running value only. It does not change the saved setting this tool shows, and the keyboard returns to the saved setting when the configuration reloads.';

export type SettingsDevice = { connected: false } | { connected: true; deviceId: number | undefined; model: string | null };

export function isUhk80(device: SettingsDevice): boolean {
    return device.connected && device.deviceId === UHK_80_DEVICE.id;
}

export interface HostConnectionJson {
    type: string;
    name?: string;
}

/**
 * Host connections as AI clients see them: every slot in order, since switchHost takes a slot number and pairing
 * starts from an empty slot, with only what identifies a host to the user. Addresses and pairing data stay out.
 */
export function hostConnectionsForAi(connections: HostConnectionJson[]): unknown {
    return connections.map(({ name, type }) => type === 'Empty' ? { type } : { name, type });
}

function hiddenFields(group: SettingsGroup, device: SettingsDevice): readonly string[] {
    return device.connected && !isUhk80(device) ? group.uhk80Fields ?? [] : [];
}

export function settingsGroupValues(name: McpSettingsGroupName, json: UserConfigurationJson, device: SettingsDevice): Record<string, unknown> {
    const group = SETTINGS_GROUPS[name];
    const hidden = hiddenFields(group, device);
    const fields = group.fields.filter(field => !hidden.includes(field));
    if (name === 'modules') {
        const modules = json.moduleConfigurations as Array<{ id: string }>;
        return Object.fromEntries(modules.map(module => [module.id, module]));
    }
    return Object.fromEntries(fields.map(field => [field, field === 'hostConnections'
        ? hostConnectionsForAi(json[field] as HostConnectionJson[])
        : json[field]]));
}

export function readSettings(json: UserConfigurationJson, device: SettingsDevice, group?: McpSettingsGroupName): unknown {
    const groups = Object.fromEntries((group ? [group] : MCP_SETTINGS_GROUP_NAMES).map(name => {
        const settings = SETTINGS_GROUPS[name];
        const { uhk80Fields = [], uhk80Only, setCommand } = settings;
        const modelName = device.connected && device.model || 'the connected keyboard';
        if (uhk80Only && !device.connected) {
            return [name, { available: 'unknown', reason: 'No keyboard is connected, so Agent cannot tell whether this model has these settings. They exist on the UHK 80 only.', setCommand }];
        }
        if (uhk80Only && !isUhk80(device)) {
            return [name, { available: false, reason: `Not available on ${modelName}.` }];
        }
        const hidden = hiddenFields(settings, device);
        const entry: Record<string, unknown> = {
            available: true,
            values: settingsGroupValues(name, json, device),
            setCommand,
        };
        if (hidden.length) {
            entry.notAvailableOnThisModel = hidden;
            entry.reason = `The battery-powered values are not available on ${modelName}.`;
        } else if (uhk80Fields.length && !device.connected) {
            entry.reason = `No keyboard is connected. ${uhk80Fields.join(', ')} exist on the UHK 80 only.`;
        }
        return [name, entry];
    }));
    return {
        summary: `Current settings in Agent, including unsaved changes, in the serializer's JSON shape. ${RUNTIME_NOTE}`,
        groups,
    };
}
