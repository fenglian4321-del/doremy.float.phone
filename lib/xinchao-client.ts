import { kvGet, kvSet, registerKvMigration } from './kv-db';
import type { XinchaoSnapshot } from './xinchao-types';
const KEY = 'float_xinchao_view_v1';
registerKvMigration(KEY);
export const xinchaoViewEnabled = () => kvGet(KEY) === 'enabled';
export const setXinchaoViewEnabled = (enabled: boolean) => kvSet(KEY, enabled ? 'enabled' : 'disabled');
export class XinchaoClientError extends Error {
    constructor(message: string, public readonly unauthorized = false) { super(message); }
}
export async function fetchXinchaoSnapshot(signal: AbortSignal): Promise<XinchaoSnapshot> {
    const response = await fetch('/api/shared-memory/xinchao', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal });
    const reply = await response.json();
    if (!response.ok || reply.ok !== true) throw new XinchaoClientError(typeof reply.error === 'string' ? reply.error : '心潮读取未完成。', response.status === 401);
    if (reply.protocol !== 'float-xinchao-read/v1' || !reply.snapshot || reply.snapshot.version !== '4.3.0'
        || !Array.isArray(reply.snapshot.drives) || typeof reply.snapshot.now?.text !== 'string') throw new XinchaoClientError('心潮看板格式不匹配。');
    return reply.snapshot as XinchaoSnapshot;
}
export async function connectXinchaoOwner(token: string, signal: AbortSignal): Promise<void> {
    const response = await fetch('/api/shared-memory', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'x-float-memory-access-token': token }, body: JSON.stringify({ action: 'connect' }) });
    if (!response.ok) throw new XinchaoClientError(response.status === 401 ? '本人访问口令未通过验证。' : '本人会话暂时无法建立，请稍后重试。', response.status === 401);
}
