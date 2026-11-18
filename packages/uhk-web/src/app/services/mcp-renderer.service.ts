import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ConfigureMcp, DEFAULT_MCP_SETTINGS, McpStatus } from 'uhk-common';

@Injectable({ providedIn: 'root' })
export class McpRendererService {
    protected readonly status = new BehaviorSubject<McpStatus>({ ...DEFAULT_MCP_SETTINGS, error: '' });
    readonly status$ = this.status.asObservable();

    configure(_input: ConfigureMcp): Promise<void> {
        return Promise.resolve();
    }
}
