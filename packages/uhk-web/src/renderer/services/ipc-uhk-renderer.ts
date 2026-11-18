/* eslint-disable @typescript-eslint/no-explicit-any */
import { IpcCommonRenderer } from '../../app/services/ipc-common-renderer';

export class IpcUhkRenderer implements IpcCommonRenderer {
    public send(channel: string, ...args: any[]): void {
        (window as any).electron.ipcRenderer.send(channel, args);
    }

    public invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
        return (window as any).electron.ipcRenderer.invoke(channel, ...args);
    }

    public on(channel: string, listener: (_: unknown, ...args: any[]) => void): this {
        (window as any).electron.ipcRenderer.on(channel, listener);
        return this;
    }

}
