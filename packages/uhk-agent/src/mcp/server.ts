import { z } from 'zod';
import { createServer, Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_SETTINGS_GROUP_NAMES, type FirmwareReferenceManual, type McpSettings, type McpToolCall, type McpToolReply } from 'uhk-common';
import { checkMcpAccess } from './access-gate';

const REFERENCE_MANUAL_URI = 'uhk://smart-macro/reference-manual';
const REFERENCE_MANUAL_MIME_TYPE = 'text/markdown';

export class AgentMcpServer {
    private server?: Server;
    private readonly active = new Set<McpServer>();

    constructor(
        private readonly request: (call: McpToolCall) => Promise<McpToolReply>,
        private readonly readReferenceManual: () => Promise<FirmwareReferenceManual>,
    ) {}

    async start(settings: Pick<McpSettings, 'enabled' | 'port' | 'token'>): Promise<void> {
        this.server = createServer((req, res) => {
            const status = checkMcpAccess(req.headers, settings);
            if (status !== 200) {
                if (status === 401) {
                    const { authorization = '' } = req.headers;
                    const challenge = authorization.startsWith('Bearer ')
                        ? 'Bearer error="invalid_token"'
                        : 'Bearer';
                    res.writeHead(401, { 'WWW-Authenticate': challenge }).end('Unauthorized. Use the current token from Agent Settings.');
                } else {
                    res.writeHead(status).end('AI access denied.');
                }
                return;
            }
            if (req.url !== '/mcp') {
                res.writeHead(404).end();
                return;
            }
            if (req.method !== 'POST') {
                res.writeHead(405, { Allow: 'POST' }).end();
                return;
            }

            const mcp = new McpServer({ name: 'uhk-agent', version: '1.0.0' });
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            this.active.add(mcp);
            res.once('close', () => {
                this.active.delete(mcp);
                void mcp.close();
            });
            mcp.registerResource('smart-macro-reference-manual', REFERENCE_MANUAL_URI, {
                title: 'Smart-macro reference manual',
                description: 'Markdown reference manual for the firmware on the connected keyboard.',
                mimeType: REFERENCE_MANUAL_MIME_TYPE,
            }, async () => ({
                contents: [{ uri: REFERENCE_MANUAL_URI, mimeType: REFERENCE_MANUAL_MIME_TYPE, text: (await this.readReferenceManual()).text }],
            }));
            const registerTool = (name: string, description: string, {
                inputSchema, readOnly = false, destructive = false, idempotent = false, run = args => this.request({ name, arguments: args }),
            }: {
                inputSchema: z.ZodRawShape | z.ZodObject;
                readOnly?: boolean;
                destructive?: boolean;
                idempotent?: boolean;
                run?: (args: Record<string, unknown>) => Promise<McpToolReply>;
            }) => {
                mcp.registerTool(name, {
                    description,
                    inputSchema,
                    annotations: {
                        readOnlyHint: readOnly,
                        destructiveHint: destructive,
                        openWorldHint: false,
                        ...(idempotent ? { idempotentHint: true } : {}),
                    },
                }, async (args: Record<string, unknown>) => {
                    try {
                        return { ...await run(args) };
                    } catch (error) {
                        return {
                            isError: true,
                            content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Agent window is unavailable.' }],
                        };
                    }
                });
            };
            const registerRead = (name: string, description: string, inputSchema: Record<string, z.ZodString> = {}) =>
                registerTool(name, description, { inputSchema, readOnly: true });
            registerTool('get_reference_manual', 'Read the full smart-macro reference manual for the firmware on the connected keyboard.', {
                inputSchema: z.strictObject({}),
                readOnly: true,
                run: async () => {
                    const { firmwareGitRepo, firmwareGitTag, text } = await this.readReferenceManual();
                    return { content: [{ type: 'text', text: `${firmwareGitRepo} ${firmwareGitTag}\n\n${text}` }] };
                },
            });
            const macroManualNote = [
                'Call get_reference_manual before writing smart-macro commands for the connected firmware.',
                'Known pitfalls: The OLED shows about 24 characters with no scrolling.',
                'Settings read back as raw values, for example `$battery.chargeLimit` reads as 1 or 0.',
                '`notify` on an if/else line shows the wrong text on firmware before the fix in UltimateHackingKeyboard/firmware#1668.',
            ].join(' ');
            registerRead('get_device_info', 'Read the connected keyboard model, firmware version, connection state and physical halves from Agent.');
            registerRead('list_keymaps', 'List current keymap names, abbreviations and layers, including unsaved changes.');
            registerRead('get_layer', [
                'Read physical key labels and serialized actions. Use a keymap abbreviation or unique name and a layer from list_keymaps.',
                'Play-macro actions also carry macroName, the name of the macro at macroIndex.',
            ].join(' '), {
                keymap: z.string(), layer: z.string(),
            });
            registerRead('list_macros', 'List current macro names and their action types.');
            registerRead('get_macro', [
                'Read a macro by name. Text macro actions are hidden unless enabled in Agent.',
                'Smart-macro commands, including text typed by `write`, are visible to the AI client.',
                macroManualNote,
            ].join(' '), {
                name: z.string(),
            });
            registerRead('get_unsaved_changes', [
                'List every difference between Agent and the keyboard, including the user\'s own edits: key actions, keymaps added or removed, macros and other settings.',
                'Save to keyboard in Agent would send all of them.',
                'aiTagged marks entries that an AI client\'s proposed changes touched.',
                'Each entry includes Agent-computed riskFlags. An empty array means no rule matched.',
                'Key actions name the macro they play instead of its index. Text actions are hidden unless enabled in Agent.',
            ].join(' '));
            registerTool('set_key_action', [
                'Change one key in Agent\'s unsaved changes. Nothing is written to the keyboard: the user reviews the change and clicks Save to keyboard in Agent.',
                'Use a keymap abbreviation or unique name and a layer from list_keymaps, and a moduleId and keyId from get_layer.',
                'action takes the serialized shape get_layer returns (playMacro uses macroIndex, the position in list_macros), or "none" to clear the key.',
                'Agent refuses the change if the keymap, layer, key or macro does not exist or the configuration would not serialize.',
                'Returns Agent-computed riskFlags for the change. An empty array means no rule matched.',
                'Passing the checks proves the configuration loads, not that it works: the user must save and press the key.',
            ].join(' '), {
                idempotent: true,
                inputSchema: {
                    keymap: z.string(),
                    layer: z.string(),
                    moduleId: z.number().int(),
                    keyId: z.number().int(),
                    action: z.union([z.literal('none'), z.record(z.string(), z.unknown())]),
                },
            });
            const macroWriteNote = 'Proposes an unsaved change and returns Agent-computed riskFlags. An empty array means no rule matched. The user reviews it and clicks Save to keyboard in Agent, then presses the assigned key to verify it works.';
            const macroName = z.string();
            const macroActions = z.array(z.record(z.string(), z.unknown())).describe('Ordered actions in the serializer JSON shape returned by get_macro.');
            const macroFlags = { isLooped: z.boolean().optional(), isPrivate: z.boolean().optional() };
            registerTool('create_macro',
                `Create a macro with a unique name. isLooped and isPrivate default to false. ${macroManualNote} ${macroWriteNote}`, {
                    inputSchema: { name: macroName, macroActions, ...macroFlags },
                });
            registerTool('update_macro',
                `Update a macro by name. Supply at least one of macroActions, isLooped or isPrivate. Omitted fields are kept. macroActions replaces the entire action list. Supply the actual replacement text for text actions, whose contents Agent can keep hidden in replies. ${macroManualNote} ${macroWriteNote}`, {
                    inputSchema: { name: macroName, macroActions: macroActions.optional(), ...macroFlags },
                    destructive: true,
                    idempotent: true,
                });
            registerTool('rename_macro',
                `Rename a macro by name and keep its existing key assignments. ${macroWriteNote}`, {
                    inputSchema: { name: macroName, newName: macroName },
                    destructive: true,
                    idempotent: true,
                });
            registerTool('delete_macro',
                `Delete a macro by name. If it is assigned to keys, Agent refuses and lists those keys. ${macroWriteNote}`, {
                    inputSchema: { name: macroName },
                    destructive: true,
                    idempotent: true,
                });
            const keymapWriteNote = 'Nothing is written to the keyboard: Agent proposes an unsaved change and returns Agent-computed riskFlags (an empty array means no rule matched). The user reviews it and clicks Save to keyboard in Agent.';
            const keymapId = z.string().describe('A keymap abbreviation or unique name from list_keymaps.');
            const abbreviationRule = 'An abbreviation is 1 to 3 uppercase letters or digits, as the keyboard display shows it; newer firmware also allows some symbols.';
            registerTool('duplicate_keymap',
                `Copy a keymap, every layer included, under a new unique name and abbreviation. Use a keymap abbreviation or unique name from list_keymaps. ${abbreviationRule} ${keymapWriteNote}`, {
                    inputSchema: { keymap: keymapId, name: z.string(), abbreviation: z.string() },
                });
            registerTool('rename_keymap',
                `Change a keymap's name, abbreviation or description. Use a keymap abbreviation or unique name from list_keymaps. Keys that switch to it keep working: they follow a new abbreviation. ${abbreviationRule} ${keymapWriteNote}`, {
                    inputSchema: { keymap: keymapId, name: z.string().optional(), abbreviation: z.string().optional(), description: z.string().optional() },
                    destructive: true,
                    idempotent: true,
                });
            registerTool('delete_keymap',
                `Delete a keymap. Use a keymap abbreviation or unique name from list_keymaps. Agent refuses the default keymap, and refuses a keymap that other keys switch to, listing those keys. ${keymapWriteNote}`, {
                    inputSchema: { keymap: keymapId },
                    destructive: true,
                    idempotent: true,
                });
            registerTool('set_default_keymap',
                `Make a keymap the default, the one the keyboard starts in. Use a keymap abbreviation or unique name from list_keymaps. ${keymapWriteNote}`, {
                    inputSchema: { keymap: keymapId },
                    destructive: true,
                    idempotent: true,
                });
            registerTool('get_settings', [
                'Read the keyboard settings outside keymaps and macros, including unsaved changes, grouped as Agent\'s Device screens group them:',
                'typingBehavior, mouseKeySpeed, led, battery, connections and modules (keyed by module id). Omit group to read all groups.',
                'Values use the serializer JSON shape, as in get_unsaved_changes. Connections list host names and types only.',
                'A group the connected model lacks is marked available: false.',
                'Each group names the smart-macro `set` command that changes it while the keyboard runs; such a runtime change does not update the saved setting shown here.',
            ].join(' '), {
                readOnly: true,
                inputSchema: { group: z.enum(MCP_SETTINGS_GROUP_NAMES).optional() },
            });
            registerTool('update_settings', [
                'Propose persistent changes to typingBehavior, mouseKeySpeed, led, battery or modules. Prefer update_settings over smart-macro `set` commands in $onInit for persistent changes.',
                'Use values from get_settings in the serializer JSON shape and send only the fields you want to change. For modules, send objects keyed by module ID with just the settings to edit.',
                'Use the Advanced secondaryRoleStrategy when editing advanced typing settings. Legacy fields and derived configuration metadata are read-only. Manage connections, pairing and Bluetooth in Agent.',
                'Review the AI-tagged proposal in Agent and use Save to keyboard to apply it.',
            ].join(' '), {
                inputSchema: { group: z.enum(MCP_SETTINGS_GROUP_NAMES), values: z.record(z.string(), z.unknown()) },
                idempotent: true,
            });
            registerRead('get_macro_errors', 'Read cached firmware macro errors and the latest status text, including setStatus output, after saving and pressing the assigned key.');
            void (async () => {
                try {
                    await mcp.connect(transport);
                    await transport.handleRequest(req, res);
                } catch {
                    // SDK/connection backstop: the SDK normally sends its own error response.
                    // Preserve that response if headers were already written.
                    if (!res.headersSent) {
                        res.writeHead(500).end('MCP request failed.');
                    }
                    res.end();
                }
            })();
        });
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(settings.port, '127.0.0.1', () => {
                this.server.removeListener('error', reject);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) {
            return;
        }
        const server = this.server;
        this.server = undefined;
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeAllConnections();
        await Promise.allSettled([...this.active].map(mcp => mcp.close()));
        this.active.clear();
        await closed;
    }
}
