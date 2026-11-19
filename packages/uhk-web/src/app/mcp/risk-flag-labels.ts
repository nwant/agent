import type { RiskFlag } from './risk-flags';

export const RISK_FLAG_LABELS: Record<RiskFlag, string> = {
    runsWithoutKeyPress: 'Runs without a key press',
    typesIntoHost: 'Types into the host',
    opensLauncherOrShell: 'Opens a launcher or shell',
    cannotBeChecked: 'Can’t be checked',
    changesKeyboard: 'Changes the keyboard itself',
    lockout: 'Lockout',
};
