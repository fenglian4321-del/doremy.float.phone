import { kvGet, kvSet, kvSetAsync, kvRemove, registerDynamicPrefix } from './kv-db';
import type { PhoneFileScope } from './scoped-phone-files';
import type { LlmRequestMessage, LlmToolCall, LlmToolDefinition } from './llm-provider-adapter';

const PREFIX = 'float_shizuku_receipt_v1_'; registerDynamicPrefix(PREFIX);
const RUN = 'float_shizuku_run_v1_'; registerDynamicPrefix(RUN);
const PROTOCOL = 'float-shizuku/v1';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const scopeKey = (s: PhoneFileScope) => { if (!['work', 'private'].includes(s.mode) || !id(s.workspaceId)) throw new ShizukuError('invalid_scope'); return s.mode + '_' + s.workspaceId; };
export type ShizukuGrant = { id: string; label: string; allowLaunch: boolean; taskDigest: string; expires: number; epoch: number };
export type ShizukuStatus = { supported: boolean; ready: boolean; status: string; identity: string; uid: number; epoch: number };
type Reply = { state: string; code?: string; requestId?: string; operation?: string; replayed?: boolean; grant?: ShizukuGrant; data?: Record<string, unknown>; receipt?: { requestId: string; operation: string; state: string } };
export type ShizukuTrace = { assistant: true; id: string; tool: string; location: 'shizuku'; ok: boolean; state: 'complete' | 'uncertain' };
const messages: Record<string, string> = { native_unavailable: '当前浏览器或旧APK没有Shizuku执行桥，请使用配套新版APK。', not_installed: '请自行安装Shizuku；不会代你安装或开启无线调试。', not_running: 'Shizuku未启动，请由你在手机上启动。', permission_required: 'Shizuku尚未授权或权限已撤销。', denied: 'Shizuku授权被拒绝，请自行在Shizuku中核对。', not_ready: '请先授权并连接Float的Shizuku执行通道。', grant_expired: 'Shizuku当前任务授权已停止、断开或过期。', task_mismatch: '任务文字或执行轮次与Shizuku授权不符。', action_uncertain: 'Shizuku结果未确认；请核对原回执，不会自动重做。', task_inactive: '原工作区任务已停止或被接管，Shizuku未继续执行。', package_denied: '不操作权限、安全、系统设置、Shizuku或Float自身应用。' };
export class ShizukuError extends Error { constructor(public code: string) { super(messages[code] || 'Shizuku操作未确认；没有切换到无障碍、SAF或VPS执行。'); } }
function native() {
    const api = typeof window === 'undefined' ? undefined : (window as unknown as { AndroidShell?: { getShizukuStatus?: () => string; shizukuControl?: (json: string) => string } }).AndroidShell;
    if (!api || typeof api.getShizukuStatus !== 'function' || typeof api.shizukuControl !== 'function') throw new ShizukuError('native_unavailable');
    return api as { getShizukuStatus(): string; shizukuControl(json: string): string };
}
function parse(raw: string): Record<string, unknown> {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 32768) throw new ShizukuError('protocol');
    let value: unknown; try { value = JSON.parse(raw); } catch { throw new ShizukuError('protocol'); }
    if (!object(value) || value.protocol !== PROTOCOL || !['pending', 'complete', 'failed'].includes(String(value.state))) throw new ShizukuError('protocol');
    if (value.state === 'failed') throw new ShizukuError(typeof value.code === 'string' ? value.code : 'unavailable');
    return value;
}
export function shizukuStatus(): ShizukuStatus {
    try { const v = parse(native().getShizukuStatus()); if (typeof v.status !== 'string' || typeof v.ready !== 'boolean' || typeof v.identity !== 'string' || !Number.isInteger(v.uid) || !Number.isInteger(v.epoch) || (v.ready && ![0, 2000].includes(Number(v.uid)))) throw new ShizukuError('protocol'); return { supported: true, ready: v.ready, status: v.status, identity: v.identity, uid: Number(v.uid), epoch: Number(v.epoch) }; }
    catch { return { supported: false, ready: false, status: 'native_unavailable', identity: 'unknown', uid: -1, epoch: -1 }; }
}
export function shizukuControl(operation: 'permission' | 'connect' | 'disconnect') { return parse(native().shizukuControl(JSON.stringify({ operation }))); }
function control(operation: string, scope: PhoneFileScope, extra: Record<string, unknown> = {}): Reply {
    scopeKey(scope); return parse(native().shizukuControl(JSON.stringify({ operation, scope, ...extra }))) as Reply;
}
function grant(raw: unknown): ShizukuGrant {
    if (!object(raw) || !id(raw.id) || typeof raw.label !== 'string' || raw.label.length > 80 || typeof raw.allowLaunch !== 'boolean' || typeof raw.taskDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.taskDigest) || !Number.isSafeInteger(raw.expires) || !Number.isSafeInteger(raw.epoch)) throw new ShizukuError('protocol');
    return raw as ShizukuGrant;
}
async function wait(scope: PhoneFileScope, requestId: string, first: Reply, signal?: AbortSignal): Promise<Reply> {
    const abort = () => { try { control('cancel', scope, { requestId }); } catch { /* Metadata receipt remains, no replay. */ } };
    signal?.addEventListener('abort', abort, { once: true }); const started = Date.now();
    try { let reply = first; while (reply.state === 'pending') { signal?.throwIfAborted(); if (Date.now() - started > 90000) throw new ShizukuError('action_uncertain'); await new Promise(resolve => setTimeout(resolve, 150)); reply = control('result', scope, { requestId }); } signal?.throwIfAborted(); if (reply.requestId !== requestId) throw new ShizukuError('protocol'); return reply; }
    catch (error) { abort(); throw error; } finally { signal?.removeEventListener('abort', abort); }
}
export async function probeShizukuIdentity(scope: PhoneFileScope, signal?: AbortSignal) {
    signal?.throwIfAborted(); const requestId = crypto.randomUUID();
    const reply = await wait(scope, requestId, control('probe', scope, { requestId }), signal);
    if (!object(reply.data) || ![0, 2000].includes(Number(reply.data.uid)) || reply.data.operation !== 'system_info' || reply.data.location !== 'android_shizuku') throw new ShizukuError('protocol');
    return reply.data;
}
export async function requestShizukuGrant(scope: PhoneFileScope, task: string, allowLaunch: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted(); if (!task.trim() || task.length > 4000) throw new ShizukuError('task_mismatch'); const requestId = crypto.randomUUID();
    return grant((await wait(scope, requestId, control('grant', scope, { requestId, task, allowLaunch }), signal)).grant);
}
export function revokeShizukuGrant(scope: PhoneFileScope, grantId: string) { control('revoke', scope, { grantId }); }
export function shizukuPending(scope: PhoneFileScope): { requestId: string; operation: string } | null { try { const raw = kvGet(PREFIX + scopeKey(scope)); if (!raw) return null; const v = JSON.parse(raw); return object(v) && id(v.requestId) && typeof v.operation === 'string' ? v as { requestId: string; operation: string } : { requestId: 'invalid_pending', operation: 'unconfirmed' }; } catch { return { requestId: 'invalid_pending', operation: 'unconfirmed' }; } }
export function shizukuReceipt(scope: PhoneFileScope) { const pending = shizukuPending(scope); return pending ? control('receipt', scope, { requestId: pending.requestId }) : null; }
export function acknowledgeShizukuReceipt(scope: PhoneFileScope) { kvRemove(PREFIX + scopeKey(scope)); }
const sessions = new Map<string, ShizukuSession>();
export function getShizukuSession(scope: PhoneFileScope) { const value = sessions.get(scopeKey(scope)); return value && !value.signal.aborted ? value : null; }
export function disableShizukuTools(scope: PhoneFileScope) { const old = sessions.get(scopeKey(scope)); sessions.delete(scopeKey(scope)); old?.stop(); }
export function enableShizukuTools(scope: PhoneFileScope, chosen: ShizukuGrant) { disableShizukuTools(scope); const value = new ShizukuSession({ ...scope }, chosen); sessions.set(scopeKey(scope), value); try { value.check(); return value; } catch (e) { disableShizukuTools(scope); throw e; } }
const definitions: LlmToolDefinition[] = [
    { name: 'shizuku_system_info', description: '通过已授权Shizuku UserService读取真实执行UID、shell/root身份和Android版本，不读取用户数据。', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    { name: 'shizuku_app_info', description: '通过Shizuku查询本任务用户明确所选应用的安装与启动组件信息；不接受任意包名，不读私有文件。', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    { name: 'shizuku_launch_app', description: '通过Shizuku ActivityManager启动本任务用户所选应用，需手机上逐次确认；返回系统报告，不代表已完成应用内业务。不点击、不输入。', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
];
export class ShizukuSession {
    private controller = new AbortController(); readonly signal = this.controller.signal;
    private origin = window.location.origin; private boundTask = false; private used = false; private run?: { runId: string; claim: string }; private seen = new Set<string>();
    constructor(readonly scope: PhoneFileScope, readonly grant: ShizukuGrant) {}
    stop() { this.controller.abort(); try { revokeShizukuGrant(this.scope, this.grant.id); } catch { /* Native death/expiry already cancelled the task. */ } }
    check(signal?: AbortSignal) {
        signal?.throwIfAborted(); this.signal.throwIfAborted(); const status = shizukuStatus();
        if (window.location.origin !== this.origin || sessions.get(scopeKey(this.scope)) !== this || !status.ready || status.epoch !== this.grant.epoch || shizukuPending(this.scope)) throw new ShizukuError('grant_expired');
        const current = grant(control('grant_status', this.scope, { grantId: this.grant.id }).grant);
        if (current.taskDigest !== this.grant.taskDigest || current.allowLaunch !== this.grant.allowLaunch || current.epoch !== this.grant.epoch) throw new ShizukuError('task_mismatch');
    }
    async bindTask(task: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(task)); if ([...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('') !== this.grant.taskDigest) throw new ShizukuError('task_mismatch'); this.boundTask = true; }
    bindRun(run: { runId: string; claim: string }) { if (!this.boundTask) throw new ShizukuError('task_mismatch'); const current = grant(control('activate', this.scope, { grantId: this.grant.id, ...run, taskDigest: this.grant.taskDigest }).grant); if (current.taskDigest !== this.grant.taskDigest) throw new ShizukuError('task_mismatch'); this.run = { ...run }; }
    begin(runId: string) { this.check(); if (this.used || !this.run || this.run.runId !== runId) throw new ShizukuError('task_mismatch'); this.used = true; kvSet(RUN + scopeKey(this.scope), JSON.stringify({ runId, at: Date.now() })); }
    tools() { this.check(); return definitions.filter(tool => this.grant.allowLaunch || tool.name !== 'shizuku_launch_app'); }
    async execute(call: LlmToolCall, outer: AbortSignal, trace?: (value: ShizukuTrace) => void): Promise<LlmRequestMessage> {
        const signal = AbortSignal.any([outer, this.signal]); this.check(signal);
        if (!this.used || !this.run || !id(call.id) || (call.providerCallId !== undefined && call.providerCallId !== call.id) || this.seen.has(call.id) || this.seen.size >= 64 || !this.tools().some(tool => tool.name === call.name) || !object(call.args) || Object.keys(call.args).length) throw new ShizukuError('invalid_request');
        this.seen.add(call.id); const operation = call.name.replace('shizuku_', ''), requestId = crypto.randomUUID();
        // Must durably record intent before invoking a native privileged RPC.
        await kvSetAsync(PREFIX + scopeKey(this.scope), JSON.stringify({ requestId, operation, at: Date.now() })); signal.throwIfAborted();
        try {
            const reply = await wait(this.scope, requestId, control('action', this.scope, { grantId: this.grant.id, requestId, action: operation }), signal);
            if (reply.replayed || !object(reply.data) || reply.data.location !== 'android_shizuku' || reply.data.operation !== operation || ![0, 2000].includes(Number(reply.data.uid)) || reply.receipt?.state !== 'complete' || reply.receipt.requestId !== requestId || reply.receipt.operation !== operation) throw new ShizukuError('action_uncertain');
            const state = shizukuStatus(); if (!state.ready || state.epoch !== this.grant.epoch || state.uid !== reply.data.uid) throw new ShizukuError('grant_expired');
            signal.throwIfAborted(); kvRemove(PREFIX + scopeKey(this.scope)); this.check(signal);
            trace?.({ assistant: true, id: call.id, tool: call.name, location: 'shizuku', ok: true, state: 'complete' });
            return { role: 'tool', name: call.name, toolCallId: call.id, content: JSON.stringify({ ...reply.data, untrustedData: true, receiptId: requestId, businessSuccessVerified: false }) };
        } catch (e) { trace?.({ assistant: true, id: call.id, tool: call.name, location: 'shizuku', ok: false, state: 'uncertain' }); this.stop(); throw e; }
    }
}
