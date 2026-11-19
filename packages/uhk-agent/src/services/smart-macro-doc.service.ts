import fastifyStatic from '@fastify/static';
import { ipcMain } from 'electron';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import getPort from 'get-port';
import fastify, { FastifyInstance } from 'fastify';
import { FirmwareRepoInfo, IpcEvents, LogService, type FirmwareReferenceManual } from 'uhk-common';
import { pathExists } from 'uhk-fs';
import { getPackageJsonFromPathAsync } from 'uhk-usb';
import { downloadSmartMacroDoc, DownloadSmartMacroDocOptions, downloadSmartMacroReferenceManual, REFERENCE_MANUAL_FILE_NAME } from 'uhk-smart-macro';

import {
    copySmartMacroDocToWebserver,
    copySmartMacroLoadingHtml,
    getDefaultFirmwarePath,
    getSmartMacroDocRootPath,
    makeFolderWriteableToUserOnLinux
} from '../util';
import { QueueManager } from './queue-manager';

const LOG_PREFIX = '[SmartMacroService]';

export class SmartMacroDocService {
    private _isRunning = false;
    private port: number;
    private queueManager = new QueueManager();
    private staticServer: FastifyInstance;
    private readonly rootPath: string;
    private readonly pendingManuals = new Map<string, Promise<string>>();

    constructor(private logService: LogService,
                private rootDir: string) {
        this.rootPath = getSmartMacroDocRootPath();
        ipcMain.on(IpcEvents.app.getAppStartInfo, (...args) => {
            this.queueManager.add({
                method: this.handleAppStartInfo,
                bind: this,
                params: args,
                asynchronous: true
            });
        });
        ipcMain.on(IpcEvents.smartMacroDoc.downloadDocumentation, (...args) => {
            this.queueManager.add({
                method: this.handleDownloadDocumentation,
                bind: this,
                params: args,
                asynchronous: true
            });
        });
    }

    public get isRunning(): boolean {
        return this._isRunning;
    }

    async start(): Promise<void> {
        try {
            this.logService.misc(serviceLogMessage('starting...'));
            const firmwarePathData = getDefaultFirmwarePath(this.rootDir);
            // Bundled smart-macro docs are optional for keymap editing. A copy
            // failure (e.g. EACCES against a leftover read-only tree from an
            // immutable install prefix) must not abort createWindow().
            try {
                await copySmartMacroDocToWebserver(firmwarePathData, this.logService);
                await copySmartMacroLoadingHtml(this.rootDir, this.logService);
                await makeFolderWriteableToUserOnLinux(getSmartMacroDocRootPath());
            } catch (err) {
                this.logService.error(
                    serviceLogMessage('documentation setup failed; continuing without bundled smart-macro docs'),
                    err
                );
            }
            this.logService.misc(serviceLogMessage('get free TCP port'));
            this.port = await getPort();
            this.logService.misc(serviceLogMessage(`acquired TCP port: ${this.port}`));
            this.staticServer = fastify();
            this.staticServer.register(fastifyStatic, {
                root: this.rootPath,
                prefix: '/'
            });
            await this.staticServer.listen({
                port: this.port
            });
            this.logService.misc(serviceLogMessage(`started on ${this.port}.`));
            this._isRunning = true;

        } catch (err) {
            this.logService.error(serviceLogMessage(`can't be started on ${this.port}`), err);

            throw err;
        }
    }

    async stop(): Promise<void> {
        this.logService.misc(serviceLogMessage('stopping...'));

        await this.staticServer.close();
        this._isRunning = false;

        this.logService.misc(serviceLogMessage('stopped.'));
    }

    public async readConnectedReferenceManual(firmware: FirmwareRepoInfo | undefined): Promise<FirmwareReferenceManual> {
        if (!firmware) {
            throw new Error('Connect a keyboard in Agent to read its smart-macro reference manual.');
        }

        try {
            return await this.readVersionedReferenceManual(this.documentationOptions(firmware));
        } catch (error) {
            this.logService.error(serviceLogMessage('Could not read the connected firmware reference manual'), error);
            throw new Error('The smart-macro reference manual is unavailable for the connected firmware.');
        }
    }

    private async downloadDocumentation(event: Electron.IpcMainEvent, firmwareRepoInfo: FirmwareRepoInfo): Promise<void> {
        this.logService.misc(serviceLogMessage('start downloading firmware documentation'), firmwareRepoInfo);
        const options = this.documentationOptions(firmwareRepoInfo);
        const indexHtmlPath = join(options.directory, 'index.html');

        if (!await pathExists(indexHtmlPath)) {
            this.logService.misc(serviceLogMessage('firmware documentation downloading'));

            await downloadSmartMacroDoc(options);

            this.logService.misc(serviceLogMessage('firmware documentation downloaded'));
        }
        else {
            this.logService.misc(serviceLogMessage('firmware documentation downloaded earlier'));
        }

        event.sender.send(IpcEvents.smartMacroDoc.downloadDocumentationReply, firmwareRepoInfo);

        const referenceManual = await this.readVersionedReferenceManual(options);
        event.sender.send(IpcEvents.smartMacroDoc.referenceManualReply, referenceManual);
    }

    private documentationOptions({ firmwareGitRepo = '', firmwareGitTag: ref = '' }: FirmwareRepoInfo): DownloadSmartMacroDocOptions {
        const [owner, repo, ...rest] = firmwareGitRepo.split('/');
        // Firmware supplies these identifiers. Keep each path under its own cache entry.
        const isPathSegment = (value: string) => !!value && value !== '.' && value !== '..' && !/[\\%?#:]/.test(value);
        if (rest.length || !isPathSegment(owner) || !isPathSegment(repo) || !ref.split('/').every(isPathSegment)) {
            throw new Error('Missing or invalid firmware repository or tag.');
        }
        return { owner, repo, ref, directory: join(this.rootPath, owner, repo, ref) };
    }

    private async readVersionedReferenceManual(options: DownloadSmartMacroDocOptions): Promise<FirmwareReferenceManual> {
        return {
            firmwareGitRepo: `${options.owner}/${options.repo}`,
            firmwareGitTag: options.ref,
            text: await this.readReferenceManual(options),
        };
    }

    private readReferenceManual(options: DownloadSmartMacroDocOptions): Promise<string> {
        const directory = join(options.directory, 'doc-dev');
        let pending = this.pendingManuals.get(directory);
        if (pending === undefined) {
            pending = this.loadReferenceManual({ ...options, directory }).finally(() => this.pendingManuals.delete(directory));
            this.pendingManuals.set(directory, pending);
        }
        return pending;
    }

    private async loadReferenceManual(options: DownloadSmartMacroDocOptions): Promise<string> {
        const { directory } = options;
        const path = join(directory, REFERENCE_MANUAL_FILE_NAME);
        const cached = await fs.readFile(path, 'utf8').catch(error => {
            if (error.code === 'ENOENT') {
                return '';
            }
            throw error;
        });
        if (cached.trim()) {
            return cached;
        }

        this.logService.misc(serviceLogMessage('reference manual downloading'));
        await fs.mkdir(directory, { recursive: true });
        const temporaryDirectory = await fs.mkdtemp(join(directory, '.download-'));
        try {
            await downloadSmartMacroReferenceManual({ ...options, directory: temporaryDirectory });
            const downloadedPath = join(temporaryDirectory, REFERENCE_MANUAL_FILE_NAME);
            const text = await fs.readFile(downloadedPath, 'utf8');
            if (!text.trim()) {
                throw new Error('Reference manual is empty.');
            }
            await fs.rename(downloadedPath, path);
            this.logService.misc(serviceLogMessage('reference manual downloaded'));
            return text;
        } finally {
            await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
    }

    private async fallbackToBundledFirmware(event: Electron.IpcMainEvent): Promise<void> {
        this.logService.misc(serviceLogMessage('fallback to bundled firmware documentation'));
        try {
            const { packageJsonPath } = getDefaultFirmwarePath(this.rootDir);
            const { gitInfo } = await getPackageJsonFromPathAsync(packageJsonPath);
            const firmwareRepoInfo: FirmwareRepoInfo = {
                firmwareGitRepo: gitInfo.repo,
                firmwareGitTag: gitInfo.tag,
            }
            await this.downloadDocumentation(event, firmwareRepoInfo)
        }
        catch (error) {
            this.logService.error(serviceLogMessage('failed to fallback to bundled documentation'), error);
        }
    }

    private async handleAppStartInfo(event: Electron.IpcMainEvent): Promise<void> {
        this.logService.misc(serviceLogMessage('getAppStartInfo'));

        event.sender.send(IpcEvents.smartMacroDoc.serviceListening, this.port);
    }

    private async handleDownloadDocumentation(event: Electron.IpcMainEvent, args: [FirmwareRepoInfo]): Promise<void> {
        try {
            const firmwareRepoInfo: FirmwareRepoInfo = args[0];
            if (!firmwareRepoInfo.firmwareGitRepo || !firmwareRepoInfo.firmwareGitTag) {
                this.logService.misc(serviceLogMessage('fallback to bundled firmware documentation because git repo or tag missing'), firmwareRepoInfo);
                return this.fallbackToBundledFirmware(event);
            }

            // `await` is required so that a rejection from downloadDocumentation is caught here
            // instead of escaping. This happens e.g. with development firmware whose git tag does
            // not exist on GitHub, in which case we fall back to the bundled firmware grammar.
            return await this.downloadDocumentation(event, firmwareRepoInfo);
        } catch (error) {
            const message: string = error?.message ?? '';
            const reason = message.split(' - ')[0];
            this.logService.error(serviceLogMessage(`download running firmware documentation failed: ${reason}. This is normal for unpublished builds.`));
            return this.fallbackToBundledFirmware(event);
        }
    }
}

function serviceLogMessage(message: string): string {
    return `${LOG_PREFIX} ${message}`;
}
