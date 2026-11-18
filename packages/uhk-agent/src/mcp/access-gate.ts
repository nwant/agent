import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { McpSettings } from 'uhk-common';

export function checkMcpAccess(headers: IncomingHttpHeaders, settings: McpSettings): number {
    if (!settings.enabled || headers.origin !== undefined || headers.host !== `127.0.0.1:${settings.port}`) {
        return 403;
    }

    if (!settings.token || !headers.authorization) {
        return 401;
    }

    const expected = Buffer.from(`Bearer ${settings.token}`);
    const provided = Buffer.from(headers.authorization);
    return provided.length === expected.length && timingSafeEqual(provided, expected) ? 200 : 401;
}
