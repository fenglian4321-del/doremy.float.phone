// Shared validation only. No service URLs, secrets, network, life data or executor.
export const MANAGED_MCP_PROTOCOL = 'float-managed-mcp/v1';
export type ManagedMcpScope = { mode: 'work' | 'private'; workspaceId: string };
export type ManagedMcpRunRef = { runId: string; claim: string };
export type ManagedMcpTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ManagedMcpService = { id: string; name: string; revision: string; tools: ManagedMcpTool[] };
export type ManagedMcpBinding = { version: number; enabled: boolean; services: { id: string; revision: string; tools: string[] }[] };
export type ManagedMcpReceipt = { requestId: string; serviceId: string; tool: string; state: 'reserved' | 'complete' | 'failed' | 'uncertain' | 'cancelled'; at: number; code?: string };
export type ManagedMcpReply = { protocol: typeof MANAGED_MCP_PROTOCOL; available: boolean; binding?: ManagedMcpBinding; services?: ManagedMcpService[]; receipt?: ManagedMcpReceipt; text?: string; isError?: boolean; verified?: boolean; replayed?: boolean; untrustedData?: true };
export class ManagedMcpError extends Error {
    constructor(public code: string, message = '受控MCP操作未确认；没有改用其他执行器。', public status = 400) { super(message); }
}
export const mcpObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function mcpExact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    if (!mcpObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw new ManagedMcpError('schema', 'MCP参数含未授权字段。');
}
export function mcpId(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new ManagedMcpError('identifier'); }
export function mcpScope(value: unknown): asserts value is ManagedMcpScope {
    mcpExact(value, ['mode', 'workspaceId']);
    if (!['work', 'private'].includes(String(value.mode))) throw new ManagedMcpError('scope', 'MCP仅支持明确工作/私人空间，不读取生活区。', 403);
    mcpId(value.workspaceId);
}
export function mcpCanonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(mcpCanonical).join(',') + ']';
    if (mcpObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + mcpCanonical(value[key])).join(',') + '}';
    const encoded = JSON.stringify(value);
    if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new ManagedMcpError('schema');
    return encoded;
}
/** Deliberately bounded JSON Schema subset; no refs, regexes or executable validators. */
export function validateManagedMcpSchema(raw: unknown, depth = 0): asserts raw is Record<string, unknown> {
    mcpExact(raw, ['type', 'properties', 'required', 'additionalProperties', 'items', 'maxItems', 'minItems', 'maxLength', 'minLength', 'minimum', 'maximum', 'enum', 'description', 'title', '$schema']);
    if (depth > 4 || !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(raw.type))) throw new ManagedMcpError('schema', '工具Schema超出首版支持范围。');
    for (const key of ['description', 'title', '$schema']) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || (raw[key] as string).length > 512)) throw new ManagedMcpError('schema');
    if (raw.type === 'object') {
        if (!mcpObject(raw.properties) || Object.keys(raw.properties).length > 16 || raw.additionalProperties !== false || !Array.isArray(raw.required) || raw.required.some(key => typeof key !== 'string' || !Object.hasOwn(raw.properties as object, key)) || new Set(raw.required).size !== raw.required.length) throw new ManagedMcpError('schema', '工具对象必须明确字段并禁止额外字段。');
        for (const [key, child] of Object.entries(raw.properties)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new ManagedMcpError('schema');
            validateManagedMcpSchema(child, depth + 1);
        }
    }
    if (raw.type === 'array') { validateManagedMcpSchema(raw.items, depth + 1); if (!Number.isSafeInteger(raw.maxItems) || Number(raw.maxItems) < 0 || Number(raw.maxItems) > 32) throw new ManagedMcpError('schema'); }
    for (const key of ['maxLength', 'minLength', 'maxItems', 'minItems']) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0 || Number(raw[key]) > 32768)) throw new ManagedMcpError('schema');
    for (const key of ['minimum', 'maximum']) if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) throw new ManagedMcpError('schema');
    if (raw.enum !== undefined && (!Array.isArray(raw.enum) || !raw.enum.length || raw.enum.length > 32 || raw.enum.some(value => value !== null && !['string', 'boolean', 'number'].includes(typeof value)))) throw new ManagedMcpError('schema');
}
export function validateManagedMcpArguments(value: unknown, schema: Record<string, unknown>): void {
    const type = schema.type;
    if ((type === 'object' && !mcpObject(value)) || (type === 'array' && !Array.isArray(value)) || (type === 'integer' && !Number.isSafeInteger(value)) || (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) || (type === 'string' && typeof value !== 'string') || (type === 'boolean' && typeof value !== 'boolean') || (type === 'null' && value !== null)) throw new ManagedMcpError('arguments', '工具参数类型与管理员Schema不符。');
    if (Array.isArray(schema.enum) && !schema.enum.some(item => item === value)) throw new ManagedMcpError('arguments');
    if (mcpObject(value)) {
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        if (Object.keys(value).some(key => !Object.hasOwn(properties, key)) || (schema.required as string[]).some(key => !Object.hasOwn(value, key))) throw new ManagedMcpError('arguments');
        for (const [key, child] of Object.entries(value)) validateManagedMcpArguments(child, properties[key]);
    }
    if (Array.isArray(value)) { if (value.length > Number(schema.maxItems) || value.length < Number(schema.minItems ?? 0)) throw new ManagedMcpError('arguments'); for (const item of value) validateManagedMcpArguments(item, schema.items as Record<string, unknown>); }
    if (typeof value === 'string' && (value.length > Number(schema.maxLength ?? 32768) || value.length < Number(schema.minLength ?? 0))) throw new ManagedMcpError('arguments');
    if (typeof value === 'number' && (value < Number(schema.minimum ?? -Number.MAX_VALUE) || value > Number(schema.maximum ?? Number.MAX_VALUE))) throw new ManagedMcpError('arguments');
}
