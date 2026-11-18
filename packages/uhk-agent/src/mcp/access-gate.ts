import type { IncomingHttpHeaders } from 'node:http';
import type { McpSettings } from 'uhk-common';

export function checkMcpAccess(headers: IncomingHttpHeaders, settings: McpSettings): number {
    if (!settings.enabled || headers.origin !== undefined || headers.host !== `127.0.0.1:${settings.port}`) {
        return 403;
    }

    if (!settings.token || headers.authorization !== `Bearer ${settings.token}`) {
        return 401;
    }

    return 200;
}
