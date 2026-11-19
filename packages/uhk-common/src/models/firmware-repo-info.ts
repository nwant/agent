export interface FirmwareRepoInfo {
    firmwareGitRepo?: string;
    firmwareGitTag?: string;
}

export interface FirmwareReferenceManual extends Required<FirmwareRepoInfo> {
    text: string;
}
