import { kvGet, kvSet, kvRemove, registerDynamicPrefix } from './kv-db';
import { MANAGED_MCP_PROTOCOL, ManagedMcpError, mcpScope, mcpId, mcpObject, mcpExact, validateManagedMcpSchema, type ManagedMcpScope, type ManagedMcpReply, type ManagedMcpRunRef } from './managed-mcp-policy';
import type { ToolResult } from './tool-executor';
const PREFIX = 'float_managed_mcp_receipt_v1_'; registerDynamicPrefix(PREFIX);
type Pending = { requestId: string; serviceId: string; tool: string; at: number };
const key = (scope: ManagedMcpScope) => { mcpScope(scope); return PREFIX + scope.mode + '_' + scope.workspaceId; };
export function managedMcpPending(scope: ManagedMcpScope): Pending | null {
    try { const value = JSON.parse(kvGet(key(scope)) || 'null'); if (mcpObject(value) && typeof value.at === 'number') { mcpId(value.requestId); mcpId(value.serviceId); mcpId(value.tool); return value as Pending; } } catch { /* No raw body cache or replay. */ }
    return null;
}
export function clearManagedMcpWait(scope: ManagedMcpScope): void { kvRemove(key(scope)); }
export async function managedMcpControl(scope: ManagedMcpScope, operation: 'catalog' | 'bind' | 'discover' | 'call' | 'receipt' | 'cancel', payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ManagedMcpReply> {
    mcpScope(scope); signal?.throwIfAborted();
    const fields: string[] = ({ catalog: [], bind: ['version', 'enabled', 'services'], discover: ['serviceId'], call: ['serviceId', 'tool', 'args', 'requestId'], receipt: ['requestId'], cancel: ['requestId'] })[operation];
    if (fields.some(name => !Object.hasOwn(payload, name)) || Object.keys(payload).some(name => !fields.includes(name) && !(operation === 'call' && name === 'run'))) throw new ManagedMcpError('schema');
    const response = await fetch('/api/shared-memory/mcp', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, scope, ...payload }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(32000)]) : AbortSignal.timeout(32000) });
    const reader = response.body?.getReader(); if (!reader) throw new ManagedMcpError('unconfirmed');
    const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', size = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 262144) { await reader.cancel(); throw new ManagedMcpError('capacity'); } text += decoder.decode(next.value, { stream: true }); } text += decoder.decode(); } finally { reader.releaseLock(); }
    let value: unknown; try { value = JSON.parse(text); } catch { throw new ManagedMcpError('protocol', '受控MCP响应格式不匹配，未重试。'); }
    if (!response.ok) {
        const codes = ['disabled', 'unauthorized', 'forbidden', 'arguments', 'schema', 'capacity', 'busy', 'conflict', 'revoked', 'scope', 'archived', 'service_denied', 'tool_denied', 'catalog_changed', 'receipt_missing', 'cancelled_or_timeout', 'cancelled', 'timeout', 'address_denied', 'connection', 'receipt_capacity'];
        const code = mcpObject(value) && typeof value.code === 'string' && codes.includes(value.code) ? value.code : 'unconfirmed';
        throw new ManagedMcpError(code, ({ disabled: '管理员尚未启用受控MCP，没有连接服务。', unauthorized: '请先验证本人会话。', revoked: '本区MCP授权已关闭或变更。', conflict: '状态或原请求参数已变化，请核对同一回执。', receipt_missing: '本区没有此回执；没有重放工具。' })[code] || 'MCP操作未确认；请核对同一回执，不要自动重复调用。', response.status);
    }
    if (!mcpObject(value) || value.protocol !== MANAGED_MCP_PROTOCOL || typeof value.available !== 'boolean' || Object.keys(value).some(name => !['protocol', 'available', 'binding', 'services', 'receipt', 'text', 'isError', 'verified', 'replayed', 'untrustedData'].includes(name))) throw new ManagedMcpError('protocol');
    if (value.text !== undefined && (typeof value.text !== 'string' || new TextEncoder().encode(value.text).byteLength > 32768 || value.untrustedData !== true)) throw new ManagedMcpError('protocol');
    if (value.receipt !== undefined && (!mcpObject(value.receipt) || value.receipt.requestId !== payload.requestId || !['reserved', 'complete', 'failed', 'uncertain', 'cancelled'].includes(String(value.receipt.state)) || typeof value.receipt.at !== 'number')) throw new ManagedMcpError('receipt');
    if (value.services !== undefined && (!Array.isArray(value.services) || value.services.length > 8)) throw new ManagedMcpError('protocol');
    const grant = (item: unknown) => {
        mcpExact(item, ['id', 'revision', 'tools']); mcpId(item.id);
        if (typeof item.revision !== 'string' || !/^[a-f0-9]{64}$/.test(item.revision) || !Array.isArray(item.tools) || item.tools.length > 32) throw new ManagedMcpError('protocol');
        for (const tool of item.tools) mcpId(tool);
    };
    if (value.binding !== undefined) {
        mcpExact(value.binding, ['version', 'enabled', 'services']);
        if (!Number.isSafeInteger(value.binding.version) || Number(value.binding.version) < 0 || typeof value.binding.enabled !== 'boolean' || !Array.isArray(value.binding.services) || value.binding.services.length > 8) throw new ManagedMcpError('protocol');
        value.binding.services.forEach(grant);
    }
    if (Array.isArray(value.services)) for (const service of value.services) {
        mcpExact(service, ['id', 'name', 'revision', 'tools']); mcpId(service.id);
        if (Object.hasOwn(Object.prototype, service.id)) throw new ManagedMcpError('protocol');
        if (typeof service.name !== 'string' || service.name.length > 80 || typeof service.revision !== 'string' || !/^[a-f0-9]{64}$/.test(service.revision) || !Array.isArray(service.tools) || service.tools.length > 32) throw new ManagedMcpError('protocol');
        for (const tool of service.tools) { mcpExact(tool, ['name', 'description', 'inputSchema']); mcpId(tool.name); if (typeof tool.description !== 'string' || tool.description.length > 512) throw new ManagedMcpError('protocol'); validateManagedMcpSchema(tool.inputSchema); }
    }
    if (mcpObject(value.receipt)) { mcpExact(value.receipt, ['requestId', 'serviceId', 'tool', 'state', 'at', 'code']); mcpId(value.receipt.serviceId); mcpId(value.receipt.tool); if (value.receipt.code !== undefined && (typeof value.receipt.code !== 'string' || !/^[a-z_]{1,64}$/.test(value.receipt.code))) throw new ManagedMcpError('protocol'); }
    signal?.throwIfAborted();
    return value as ManagedMcpReply;
}
/** Compatibility target for executeMcpTool; never invokes the generic executor. */
export async function executeManagedMcpTool(serviceId: string, tool: string, args: Record<string, unknown>, scope?: ManagedMcpScope, requestId?: string, signal?: AbortSignal, run?: ManagedMcpRunRef): Promise<ToolResult> {
    if (!scope || !requestId) return { name: tool, success: false, error: '受控MCP需明确工作/私人空间及固定回执编号。', persistToHistory: false };
    try {
        mcpScope(scope); mcpId(serviceId); mcpId(tool); mcpId(requestId);
        const pending = managedMcpPending(scope);
        if (pending && pending.requestId !== requestId) throw new ManagedMcpError('pending', '先核对本区上次MCP回执；没有新建重复调用。');
        kvSet(key(scope), JSON.stringify({ requestId, serviceId, tool, at: Date.now() }));
        const result = await managedMcpControl(scope, 'call', { serviceId, tool, args, requestId, ...(run ? { run } : {}) }, signal);
        if (result.receipt && result.receipt.state !== 'reserved') clearManagedMcpWait(scope);
        if (result.replayed || typeof result.text !== 'string') return { name: tool, success: false, error: '回执已存在，正文未持久缓存；未重新执行工具。请人工核对。', persistToHistory: false };
        return { name: tool, success: result.receipt?.state === 'complete' && !result.isError, data: JSON.stringify({ type: 'external_mcp_data', untrustedData: true, text: result.text, requestId, location: 'configured_external_service' }), ...(result.isError ? { error: '服务返回工具错误，正文仅作为外部资料。' } : {}), persistToHistory: false };
    } catch (error) {
        if (signal?.aborted) throw error;
        return { name: tool, success: false, error: error instanceof ManagedMcpError ? error.message : 'MCP结果未确认；请核对同一回执，未自动重试。', persistToHistory: false };
    }
}
