export class IpcCommonRenderer {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(channel: string, ...args: any[]): void {

    }

    invoke<T>(_channel: string, ..._args: unknown[]): Promise<T> {
        return Promise.reject(new Error('IPC is only available in Electron.'));
    }

    on(channel: string, listener: Function): this {
        return this;
    }
}
