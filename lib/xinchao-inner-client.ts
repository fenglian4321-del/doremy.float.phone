import { kvGet, kvSetAsync, kvRemove, registerKvMigration } from './kv-db';
import { innerPreferences, characterCoreHash } from './xinchao-core';
import { loadCharacters } from './character-storage';
import type { InnerAction, InnerDocument, InnerModule } from './xinchao-inner-types';
const KEY = 'float_xinchao_inner_receipt_v1';
registerKvMigration(KEY);
export async function innerCall(body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetch('/api/shared-memory/xinchao/inner', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    const v = await response.json();
    if (!response.ok || v.ok !== true || v.protocol !== 'float-xinchao-inner/v1')
        throw new Error(typeof v.error === 'string' ? v.error : '心潮内室未完成操作。');
    return v;
}
export async function fetchInnerModule(module: InnerModule, signal?: AbortSignal): Promise<InnerDocument> {
    const v = await innerCall({ operation: 'read', module }, signal);
    if (
        v.document?.module !== module ||
        !Array.isArray(v.document.records) ||
        !Array.isArray(v.document.metrics) ||
        !v.document.controls
    )
        throw new Error('内室响应格式不符。');
    return v.document;
}
export function innerPending(): { requestId: string; action: string } | null {
    try {
        const raw = kvGet(KEY);
        if (!raw) return null;
        const v = JSON.parse(raw);
        if (typeof v.requestId === 'string' && typeof v.action === 'string') return v;
    } catch {}
    return { requestId: 'invalid_pending', action: '未确认' };
}
export function acknowledgeInner() {
    kvRemove(KEY);
}
let active = false;
export async function mutateInner(revision: number, input: InnerAction, signal?: AbortSignal) {
    if (active || innerPending()) throw new Error('有一项内室操作未确认，请先核对原回执。');
    active = true;
    const requestId = crypto.randomUUID();
    try {
        await kvSetAsync(KEY, JSON.stringify({ requestId, action: input.action }));
        signal?.throwIfAborted();
        const v = await innerCall({ operation: 'mutate', requestId, revision, input }, signal);
        if (v.state !== 'complete' || v.replayed) throw new Error('结果未确认，请核对原回执；不会自动重做。');
        kvRemove(KEY);
        return v;
    } finally {
        active = false;
    }
}
export function checkInnerReceipt(signal?: AbortSignal) {
    const p = innerPending();
    return p ? innerCall({ operation: 'receipt', requestId: p.requestId }, signal) : Promise.resolve(null);
}
export async function executeInnerTool(
    characterId: string,
    sessionId: string,
    args: unknown,
    signal?: AbortSignal,
) {
    const prefs = innerPreferences(),
        char = loadCharacters().find((c) => c.id === characterId);
    if (!prefs.tools || !prefs.binding || !char || prefs.binding.characterId !== characterId)
        throw new Error('心潮内室工具未启用，或当前不是你固定的角色。');
    const coreHash = await characterCoreHash(char);
    if (coreHash !== prefs.binding.coreHash) throw new Error('角色核心已修改，请在心潮重新核对固定绑定。');
    if (active || innerPending()) throw new Error('有一项心潮工具结果未确认，请先核对原回执。');
    active = true;
    const requestId = crypto.randomUUID();
    try {
        await kvSetAsync(KEY, JSON.stringify({ requestId, action: '角色内室工具' }));
        signal?.throwIfAborted();
        const v = await innerCall(
            { operation: 'tool', requestId, context: { sessionId, characterId, coreHash }, args },
            signal,
        );
        if (v.state !== 'complete' || v.replayed)
            throw new Error('原工具仅有回执或结果未知，请核对后再发新请求。');
        kvRemove(KEY);
        return v;
    } finally {
        active = false;
    }
}
