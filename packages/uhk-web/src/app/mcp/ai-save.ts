import type { UserConfigurationJson } from './config-diff.js';
import { findEventMacroCalls } from './event-macro-calls.js';
import { diffUserConfigurationWithRiskFlags, type RiskFlag } from './risk-flags.js';
import type { McpDeviceInfo } from './tool-handler.js';

/** Why the save path would turn a save away before it writes. */
export type SaveBlock = 'firmwareUpgrade' | 'hostConnections' | 'configurationVersion';

type NeedsUserReason = RiskFlag | 'calledByEventMacro' | 'eventMacroCallUnknown';

export interface ChangeNeedingUser {
    id: string;
    reasons: NeedsUserReason[];
}

export interface AiSaveState {
    allowed: boolean;
    info?: McpDeviceInfo;
    /** The serializer JSON of what the keyboard has, or undefined when Agent has not read it. */
    baseline?: UserConfigurationJson;
    configuration: UserConfigurationJson;
    /** Whether Agent is loading, saving, updating firmware or pairing. */
    busy: boolean;
    outOfSpace: boolean;
    saveBlock?: SaveBlock;
}

export interface AiSaveRefusal {
    message: string;
    changes?: ChangeNeedingUser[];
}

const BLOCKED_FLAGS = new Set<RiskFlag>(['runsWithoutKeyPress', 'opensLauncherOrShell', 'lockout']);

const SAVE_BLOCK_MESSAGES: Record<SaveBlock, string> = {
    firmwareUpgrade: 'The keyboard firmware must be updated first. Ask the user to update it in Agent.',
    hostConnections: 'There are too many host connections. Ask the user to remove some in Agent.',
    configurationVersion: 'The configuration is too new for the keyboard firmware. Ask the user to update the firmware in Agent.',
};

/** The changes an AI client may not save, because they could act before the user notices or lock the user out. */
export function findChangesNeedingUser(baseline: UserConfigurationJson, configuration: UserConfigurationJson): ChangeNeedingUser[] {
    const eventMacroCalls = findEventMacroCalls(configuration.macros);
    return diffUserConfigurationWithRiskFlags(baseline, configuration).flatMap(change => {
        const reasons: NeedsUserReason[] = change.riskFlags.filter(flag => BLOCKED_FLAGS.has(flag));
        if (change.type === 'macro') {
            if (change.after && eventMacroCalls.names.has(change.name)) {
                reasons.push('calledByEventMacro');
            }
            if (eventMacroCalls.unknown) {
                reasons.push('eventMacroCallUnknown');
            }
        }
        return reasons.length ? [{ id: change.id, reasons }] : [];
    });
}

/** Why an AI client may not save now, or undefined when it may. */
export function aiSaveRefusal({ allowed, info, baseline, configuration, busy, outOfSpace, saveBlock }: AiSaveState): AiSaveRefusal | undefined {
    if (!allowed) {
        return { message: 'The user does not let AI clients save. Ask them to click Save to keyboard in Agent, or to turn on "Let AI clients save to the keyboard" in Agent Settings.' };
    }
    if (!info) {
        return { message: 'Agent is still loading keyboard information. Try again shortly.' };
    }
    if (!info.connected) {
        return { message: 'No keyboard is connected. Connect a keyboard in Agent before saving.' };
    }
    if (busy) {
        return { message: 'Agent is busy loading, saving, updating firmware or pairing. Try again shortly.' };
    }
    if (!baseline) {
        return { message: "Agent does not know the keyboard's configuration, so it cannot tell what a save would change. Ask the user to save in Agent." };
    }
    if (!diffUserConfigurationWithRiskFlags(baseline, configuration).length) {
        return { message: 'There are no unsaved changes. Agent matches the keyboard.' };
    }
    if (saveBlock) {
        return { message: SAVE_BLOCK_MESSAGES[saveBlock] };
    }
    if (outOfSpace) {
        return { message: 'The configuration does not fit in the keyboard\'s space. Remove something first.' };
    }
    const changes = findChangesNeedingUser(baseline, configuration);
    return changes.length
        ? { message: 'Some changes need the user. Ask them to use Review changes and Save to keyboard in Agent.', changes }
        : undefined;
}
