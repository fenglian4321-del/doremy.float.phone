import { kvGet, kvSet, registerKvMigration } from './kv-db';
import { loadMemoryConfig } from './memory-storage';
import { beginUsageRequest } from './usage-ledger';
import { CODEX_GATEWAY_PROTOCOL, CODEX_GATEWAY_TOOLS, validateCodexTool } from './codex-gateway-policy.mjs';
import { throwIfAborted } from './abort-utils';

const KEY = 'float_codex_readonly_tools_v1';
registerKvMigration(KEY);
export const codexGatewayPreference = () => typeof window !== 'undefined' && kvGet(KEY) === 'true';
export const codexGatewayEnabled = () => codexGatewayPreference() && loadMemoryConfig().memorySource === 'shared';
export function setCodexGatewayEnabled(enabled: boolean) { kvSet(KEY, String(enabled)); }
export const isCodexGatewayTool = (name: string) => name.startsWith('float_xinchao_') || name.startsWith('float_memory_pulse');
export function getCodexGatewayTools(appId?: string) {
    return codexGatewayEnabled() && appId === 'diagnostic' ? CODEX_GATEWAY_TOOLS : [];
}
async function request(body?: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetch('/api/shared-memory/codex', { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)]),
    });
    const result = await response.json() as { ok?: boolean; error?: string; protocol?: string; available?: boolean; text?: string; requestId?: string; tool?: string; version?: string };
    if (!response.ok || !result.ok) throw new Error(result.error || 'Codex 工具调用失败。');
    if (result.protocol !== CODEX_GATEWAY_PROTOCOL) throw new Error('Codex 工具协议不兼容。');
    return result;
}
export const checkCodexGateway = (signal?: AbortSignal) => request(undefined, signal);
export async function executeCodexGatewayTool(name: string, args: Record<string, unknown>, context?: { appId?: string; sourceEngine?: string; sessionId?: string; signal?: AbortSignal }) {
    throwIfAborted(context?.signal);
    if (!codexGatewayEnabled() || !context?.sessionId || context.appId !== 'diagnostic' || context.sourceEngine !== 'diagnostic') throw new Error('这两项 Codex 原型工具仅供显式诊断，不参与日常聊天与记忆。');
    validateCodexTool(name, args);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('float-codex-scope-v1:' + context.sessionId));
    const scopeId = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    const body = { requestId: crypto.randomUUID(), scopeId, tool: name, args };
    const finish = beginUsageRequest({ provider: 'Codex MCP', model: 'executor-only', source: 'tool', scopeId, reason: 'tool_execution' });
    try {
        let reply;
        // A network failure can be ambiguous. Reuse this request's ID once; the
        // read-only gateway joins/replays its bounded in-process receipt.
        try { reply = await request(body, context.signal); }
        catch (error) { if (!(error instanceof TypeError) || context.signal?.aborted) throw error; reply = await request(body, context.signal); }
        throwIfAborted(context.signal);
        if (reply.requestId !== body.requestId || reply.tool !== name || typeof reply.text !== 'string') throw new Error('Codex 工具回执不匹配。');
        finish('completed'); return reply.text;
    } catch (error) { finish(context.signal?.aborted ? 'cancelled' : 'error'); throw error; }
}
