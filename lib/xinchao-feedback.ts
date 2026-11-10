import { fixedCoreMatches } from './xinchao-core';
import { kvGet, kvSet, registerKvMigration } from './kv-db';
type Settings = { enabled: boolean; sessionId: string; characterId: string; revision: string };
export type XinchaoFeedbackSettings = Settings;
type Turn = { sessionId: string; characterId: string; messageId: string; createdAt: string };
const KEY = 'float_xinchao_feedback_v1', RECENT = 'float_xinchao_feedback_recent_v1';
registerKvMigration(KEY); registerKvMigration(RECENT);
const off = (): Settings => ({ enabled: false, sessionId: '', characterId: '', revision: '' });
const id = (value: unknown): value is string => typeof value === 'string' && /^[^\x00-\x20\x7f]{1,160}$/.test(value);
const valid = (value: unknown): value is Settings => !!value && typeof value === 'object' && 'enabled' in value && typeof value.enabled === 'boolean' && 'sessionId' in value && 'characterId' in value && 'revision' in value && typeof value.revision === 'string' && (!value.enabled || (id(value.sessionId) && id(value.characterId) && id(value.revision)));
const pending = new Set<AbortController>(), listeners = new Set<() => void>();
let status = '尚未启用对话反馈。';
const note = (value: string) => { status = value; for (const listener of listeners) { try { listener(); } catch { /* status cannot stop chat */ } } };
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('float_xinchao_feedback_v1') : null;
export function xinchaoFeedbackSettings(): Settings {
    try { const value = JSON.parse(kvGet(KEY) || 'null'); return valid(value) ? value : off(); } catch { return off(); }
}
function stopPending() { for (const controller of pending) controller.abort(); }
if (channel) channel.onmessage = event => { if (valid(event.data)) { stopPending(); kvSet(KEY, JSON.stringify(event.data)); note('其他同源页面已调整对话反馈设置；不会补报旧消息。'); } };
export function setXinchaoFeedbackSettings(value: Omit<Settings, 'revision'>) {
    if (typeof value.enabled !== 'boolean' || (value.enabled && (!id(value.sessionId) || !id(value.characterId)))) throw new Error('请先明确选择一个生活私聊。');
    stopPending();
    const next = { enabled: value.enabled, sessionId: id(value.sessionId) ? value.sessionId : '', characterId: id(value.characterId) ? value.characterId : '', revision: crypto.randomUUID() };
    kvSet(KEY, JSON.stringify(next)); channel?.postMessage(next);
    note(next.enabled ? '已启用；仅在绑定私聊下一条新用户消息正常回复后回报普通对话互动。' : '反馈已关闭；已发送的信号无法撤回。');
}
export const xinchaoFeedbackStatus = () => status;
export const subscribeXinchaoFeedback = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const matches = (selected: Settings) => { const current = xinchaoFeedbackSettings(); return current.enabled && current.revision === selected.revision && current.sessionId === selected.sessionId && current.characterId === selected.characterId; };
function recent(): Turn[] { try { const value = JSON.parse(kvGet(RECENT) || '[]'); return Array.isArray(value) ? value.filter(item => item && id(item.sessionId) && id(item.characterId) && id(item.messageId) && typeof item.createdAt === 'string').slice(-64) : []; } catch { return []; } }
const same = (a: Turn, b: Turn) => a.sessionId === b.sessionId && a.characterId === b.characterId && a.messageId === b.messageId;
async function control(operation: 'catalog' | 'record' | 'status', turn?: Turn, signal?: AbortSignal) {
    const response = await fetch('/api/shared-memory/xinchao/feedback', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, ...(turn ? { turn } : {}) }), signal: AbortSignal.any([AbortSignal.timeout(2600), ...(signal ? [signal] : [])]) });
    const value = await response.json();
    if (!response.ok || value?.ok !== true || value.protocol !== 'float-xinchao-feedback/v1' || typeof value.available !== 'boolean') throw new Error('反馈未确认，聊天照常继续；未自动重试。');
    return value;
}
export async function checkXinchaoFeedbackAvailable() { return (await control('catalog')).available as boolean; }
export async function checkLastXinchaoFeedback() {
    const last = recent().at(-1);
    if (!last) { note('没有本机反馈标记；不会自动发送或补报。'); return; }
    try {
        const value = await control('status', last);
        const state = value.receipt?.state;
        note(state === 'recorded' ? '上次在场反馈已记录。' : state === 'rate_limited' ? '上次反馈受限频保护，未发送。' : state === 'reserved' || state === 'uncertain' ? '上次反馈结果未确认；不会自动重发。' : '服务端没有原反馈回执；未重新发送。');
    } catch { note('原反馈状态未核对，未重新发送。'); }
}
/** Capture opt-in before generation. Callback accepts no chat text or labels. */
export function prepareXinchaoFeedback(turn: Turn, signal?: AbortSignal): (() => Promise<void>) | undefined {
    const selected = xinchaoFeedbackSettings();
    if (!selected.enabled || selected.sessionId !== turn.sessionId || selected.characterId !== turn.characterId || !id(turn.messageId) || !Number.isFinite(Date.parse(turn.createdAt)) || signal?.aborted) return;
    return async () => {
        if (!matches(selected) || signal?.aborted || !await fixedCoreMatches(turn.characterId)) return;
        const previous = recent();
        if (previous.some(item => same(item, turn))) return;
        const controller = new AbortController(); pending.add(controller);
        try {
            // Only opaque metadata. Persist attempt before fetch; regeneration,
            // refresh and status recovery do not automatically send it again.
            kvSet(RECENT, JSON.stringify([...previous, turn].slice(-64)));
            // The model already completed successfully. A caller disposing its
            // generation controller must not cancel a valid completed-turn
            // acknowledgement; the independent setting still cancels it.
            const value = await control('record', turn, controller.signal);
            if (!matches(selected) || controller.signal.aborted) return;
            note(value.receipt?.state === 'recorded' ? '已回报普通对话互动；没有发送原文或推断亲密、争执。' : value.receipt?.state === 'rate_limited' ? '本轮反馈受限频保护，聊天照常继续。' : '本轮反馈未确认；可核对原回执，不自动重发。');
        } catch { if (matches(selected) && !controller.signal.aborted) note('本轮反馈未确认，聊天照常继续；未自动重试。'); }
        finally { pending.delete(controller); }
    };
}
