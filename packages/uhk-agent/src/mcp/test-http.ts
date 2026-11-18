import { createServer, request } from 'node:http';

export async function availablePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    return port;
}

export function httpRequest(options: {
    port: number;
    token?: string;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
}): Promise<{ status: number; text: string }> {
    const body = JSON.stringify(options.body ?? {});
    return new Promise((resolve, reject) => {
        const req = request({
            hostname: '127.0.0.1', port: options.port, agent: false,
            path: options.path ?? '/mcp', method: options.method ?? 'POST',
            headers: {
                Authorization: `Bearer ${options.token ?? 'test-token'}`,
                'Content-Length': Buffer.byteLength(body),
                'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                ...options.headers,
            },
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => text += chunk);
            res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.setTimeout(2_000, () => req.destroy(new Error('HTTP request timed out.')));
        req.on('error', reject);
        req.end(body);
    });
}
