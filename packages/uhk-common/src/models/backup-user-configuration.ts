import { BackupUserConfigurationInfo } from './backup-user-configuration-info.js';

export interface BackupUserConfiguration {
    /**
     * When saved the latest user configuration
     */
    date?: string;
    info: BackupUserConfigurationInfo;
    /** Serialized JSON that may use an older user configuration version. */
    userConfiguration?: unknown;
}
