import { kvGet, kvSet, kvRemove, registerDynamicPrefix } from './kv-db';
import type { PhoneFileScope } from './scoped-phone-files';
export type DeviceUiGrant = { id: string; label: string; allowActions: boolean; taskDigest: string; expires: number };
export type DeviceUiNode = { id: string; text: string; description: string; role: string; clickable: boolean; editable: boolean; enabled: boolean; sensitive: boolean; textTruncated: boolean; bounds: number[] };
export type DeviceUiSnapshot = { snapshotId: string; grantId: string; appLabel: string; nodes: DeviceUiNode[]; limited: boolean; untrustedData: true; at: number };
export type DeviceUiResult = { state: 'pending' | 'complete' | 'failed'; requestId?: string; operation?: string; replayed?: boolean; grant?: DeviceUiGrant; snapshot?: DeviceUiSnapshot; receipt?: { requestId: string; operation: string; state: 'uncertain' | 'requested'; inputVerified?: boolean; uiChanged?: boolean }; code?: string };
type Native = { getDeviceUiCapabilities(): string; requestDeviceUiGrant(scope: string, id: string, actions: boolean, task: string): string; getDeviceUiGrant(scope: string, grant: string): string; activateDeviceUiGrant(scope: string, grant: string, run: string, claim: string, digest: string): string; submitDeviceUi(json: string): string; getDeviceUiResult(scope: string, id: string): string; getDeviceUiReceipt(scope: string, id: string): string; cancelDeviceUi(scope: string, id: string): string; revokeDeviceUiGrant(scope: string, grant: string): string };
const PREFIX = 'float_phone_device_ui_v1_'; registerDynamicPrefix(PREFIX);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const messages: Record<string, string> = { accessibility_required: '请由你在系统设置启用 Float 无障碍；此处不会代开权限。', protected_application: '不控制系统权限、安全或本App界面；请手动完成这些操作。', application_changed: '前台已离开所授权应用，未继续操作。', stale_snapshot: '界面已变化或快照过期，请重新观察。', sensitive_ui: '当前界面含凭据字段，未读取；请先手动处理再继续。', grant_expired: '此任务的设备授权已停止或过期。', task_mismatch: '任务文字或执行轮次与授权不符，请重新明确授权。', task_inactive: '原手机任务已停止、离线或被接管。', action_uncertain: '动作结果未确认，不能自动重做；请查看手机和原回执。', review_declined: '此操作未获得本机确认，未执行。', ui_capacity: '当前界面结构超出容量，未将其当作完整视图。', receipt_capacity: '本机未确认动作回执达到上限，请先人工核对。' };
export class DeviceUiError extends Error { constructor(public code: string) { super(Object.hasOwn(messages, code) ? messages[code] : '手机界面操作未确认；未改用VPS、坐标或shell执行。'); } }
const key = (scope: PhoneFileScope) => { if (!['work', 'private'].includes(scope.mode) || !id(scope.workspaceId)) throw new DeviceUiError('invalid_scope'); return PREFIX + scope.mode + '_' + scope.workspaceId; };
function native(): Native {
    const value = typeof window === 'undefined' ? undefined : (window as unknown as { AndroidShell?: Partial<Native> }).AndroidShell;
    if (!value || !['getDeviceUiCapabilities', 'requestDeviceUiGrant', 'getDeviceUiGrant', 'activateDeviceUiGrant', 'submitDeviceUi', 'getDeviceUiResult', 'getDeviceUiReceipt', 'cancelDeviceUi', 'revokeDeviceUiGrant'].every(name => typeof value[name as keyof Native] === 'function')) throw new DeviceUiError('native_unavailable');
    return value as Native;
}
function grant(value: unknown): DeviceUiGrant {
    if (!object(value) || !id(value.id) || typeof value.label !== 'string' || value.label.length > 80 || typeof value.allowActions !== 'boolean' || typeof value.taskDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.taskDigest) || !Number.isSafeInteger(value.expires)) throw new DeviceUiError('protocol');
    return { id: value.id, label: value.label, allowActions: value.allowActions, taskDigest: value.taskDigest, expires: value.expires as number };
}
function snapshot(value: unknown): DeviceUiSnapshot {
    if (!object(value) || !id(value.snapshotId) || !id(value.grantId) || typeof value.appLabel !== 'string' || value.appLabel.length > 80 || typeof value.limited !== 'boolean' || value.untrustedData !== true || !Number.isSafeInteger(value.at) || !Array.isArray(value.nodes) || value.nodes.length > 128) throw new DeviceUiError('protocol');
    const seen = new Set<string>();
    const nodes = value.nodes.map(row => {
        if (!object(row) || typeof row.id !== 'string' || !/^n\d{1,3}$/.test(row.id) || seen.has(row.id) || typeof row.text !== 'string' || row.text.length > 512 || typeof row.description !== 'string' || row.description.length > 256 || typeof row.role !== 'string' || row.role.length > 100 || !['clickable', 'editable', 'enabled', 'sensitive', 'textTruncated'].every(name => typeof row[name] === 'boolean') || !Array.isArray(row.bounds) || row.bounds.length !== 4 || row.bounds.some(number => !Number.isSafeInteger(number) || Math.abs(number) > 100000)) throw new DeviceUiError('protocol');
        seen.add(row.id);
        if (row.sensitive && (row.text || row.description || row.clickable || row.editable || row.enabled)) throw new DeviceUiError('protocol');
        return { id: row.id, text: row.text, description: row.description, role: row.role, clickable: row.clickable as boolean, editable: row.editable as boolean, enabled: row.enabled as boolean, sensitive: row.sensitive as boolean, textTruncated: row.textTruncated as boolean, bounds: row.bounds as number[] };
    });
    return { snapshotId: value.snapshotId, grantId: value.grantId, appLabel: value.appLabel, nodes, limited: value.limited, untrustedData: true, at: value.at as number };
}
function parse(raw: string): DeviceUiResult & Record<string, unknown> {
    if (raw.length > 100000) throw new DeviceUiError('protocol');
    let value; try { value = JSON.parse(raw); } catch { throw new DeviceUiError('protocol'); }
    if (!object(value) || value.protocol !== 'float-shell-device-ui/v1' || value.location !== 'android_device' || typeof value.state !== 'string' || !['pending', 'complete', 'failed'].includes(value.state)) throw new DeviceUiError('protocol');
    if (value.state === 'failed') throw new DeviceUiError(typeof value.code === 'string' && /^[a-z_]{1,64}$/.test(value.code) ? value.code : 'unavailable');
    const result: DeviceUiResult & Record<string, unknown> = { state: value.state as 'pending' | 'complete', ...(id(value.requestId) ? { requestId: value.requestId } : {}), ...(typeof value.operation === 'string' ? { operation: value.operation } : {}), ...(value.replayed === true ? { replayed: true } : {}) };
    if (value.grant !== undefined) result.grant = grant(value.grant);
    if (value.snapshot !== undefined) result.snapshot = snapshot(value.snapshot);
    if (value.receipt !== undefined) {
        const row = value.receipt;
        if (!object(row) || !id(row.requestId) || !['click', 'input', 'back'].includes(String(row.operation)) || !['uncertain', 'requested'].includes(String(row.state)) || (row.inputVerified !== undefined && typeof row.inputVerified !== 'boolean') || (row.uiChanged !== undefined && typeof row.uiChanged !== 'boolean')) throw new DeviceUiError('protocol');
        result.receipt = { requestId: row.requestId, operation: row.operation as string, state: row.state as 'uncertain' | 'requested', ...(typeof row.inputVerified === 'boolean' ? { inputVerified: row.inputVerified } : {}), ...(typeof row.uiChanged === 'boolean' ? { uiChanged: row.uiChanged } : {}) };
    }
    return result;
}
export function deviceUiAvailability() { try { const value = JSON.parse(native().getDeviceUiCapabilities()); if (value.protocol !== 'float-shell-device-ui/v1' || value.location !== 'android_device' || value.state !== 'complete') throw new DeviceUiError('native_unavailable'); return { supported: true, composedTasks: value.composedTasks === true, available: value.available === true, message: value.available ? '系统无障碍可用；尚未读取界面。' : messages.accessibility_required }; } catch { return { supported: false, composedTasks: false, available: false, message: '当前浏览器或旧APK没有设备界面桥；不能转交VPS代操作。' }; } }
export function deviceUiGrant(scope: PhoneFileScope, grantId: string) { key(scope); const value = parse(native().getDeviceUiGrant(JSON.stringify(scope), grantId)); if (!value.grant || value.grant.id !== grantId) throw new DeviceUiError('protocol'); return value.grant; }
export function activateDeviceUi(scope: PhoneFileScope, grantId: string, run: { runId: string; claim: string }, taskDigest: string) { key(scope); const value = parse(native().activateDeviceUiGrant(JSON.stringify(scope), grantId, run.runId, run.claim, taskDigest)); if (!value.grant || value.grant.id !== grantId || value.grant.taskDigest !== taskDigest) throw new DeviceUiError('task_mismatch'); }
export function revokeDeviceUi(scope: PhoneFileScope, grantId: string) { key(scope); return parse(native().revokeDeviceUiGrant(JSON.stringify(scope), grantId)); }
export function deviceUiPending(scope: PhoneFileScope): { id: string; operation: string; at: number } | null { try { const value = JSON.parse(kvGet(key(scope)) || 'null'); return value && id(value.id) && typeof value.operation === 'string' ? value : null; } catch { return null; } }
export function clearDeviceUiPending(scope: PhoneFileScope) { kvRemove(key(scope)); }
export function deviceUiReceipt(scope: PhoneFileScope) { const pending = deviceUiPending(scope); if (!pending) return null; return parse(native().getDeviceUiReceipt(JSON.stringify(scope), pending.id)); }
async function wait(scope: PhoneFileScope, requestId: string, first: string, signal?: AbortSignal): Promise<DeviceUiResult> {
    const api = native(), encoded = JSON.stringify(scope); const started = Date.now();
    const cancel = () => { try { api.cancelDeviceUi(encoded, requestId); } catch { /* unknown result remains */ } };
    signal?.addEventListener('abort', cancel, { once: true });
    try { let value = parse(first); while (value.state === 'pending') { signal?.throwIfAborted(); if (Date.now() - started > 90000) throw new DeviceUiError('action_uncertain'); await new Promise(resolve => setTimeout(resolve, 180)); value = parse(api.getDeviceUiResult(encoded, requestId)); } signal?.throwIfAborted(); if (value.requestId !== requestId) throw new DeviceUiError('protocol'); return value; }
    catch (error) { cancel(); throw error; } finally { signal?.removeEventListener('abort', cancel); }
}
export async function requestDeviceUiGrant(scope: PhoneFileScope, allowActions: boolean, task: string, signal?: AbortSignal) {
    key(scope); signal?.throwIfAborted(); if (!task.trim() || task.length > 4000) throw new Error('请先用4000字以内说明本次手机任务。');
    const requestId = crypto.randomUUID(); const value = await wait(scope, requestId, native().requestDeviceUiGrant(JSON.stringify(scope), requestId, allowActions, task), signal);
    if (!value.grant) throw new DeviceUiError('grant_missing'); return value.grant;
}
export async function deviceUiCall(scope: PhoneFileScope, grantId: string, operation: 'observe' | 'click' | 'input' | 'back', args: { snapshotId?: string; nodeId?: string; text?: string } = {}, signal?: AbortSignal): Promise<DeviceUiResult> {
    key(scope); signal?.throwIfAborted(); if (deviceUiPending(scope)) throw new DeviceUiError('action_uncertain');
    const requestId = crypto.randomUUID(); kvSet(key(scope), JSON.stringify({ id: requestId, operation, at: Date.now() }));
    try { const value = await wait(scope, requestId, native().submitDeviceUi(JSON.stringify({ scope, grantId, requestId, operation, ...args })), signal); if (value.operation !== operation || (value.snapshot && value.snapshot.grantId !== grantId) || (operation !== 'observe' && (!value.receipt || value.receipt.requestId !== requestId || value.receipt.operation !== operation || value.replayed))) throw new DeviceUiError('protocol'); if (value.receipt?.state === 'uncertain') throw new DeviceUiError('action_uncertain'); kvRemove(key(scope)); return value; }
    catch (error) { if (error instanceof DeviceUiError && !['action_uncertain', 'protocol'].includes(error.code)) kvRemove(key(scope)); throw error; }
}
