import { SharedMemoryError } from './shared-memory';
import type { XinchaoSnapshot } from '../xinchao-types';

// Public 4.3.0 server.js blob 2abe7fa9d81407e84794290d23bacaf6a7027378.
// Deployment must compare its actual source before opting into this contract.
export const XINCHAO_CONTRACT = '4.3.0-2abe7fa9';
type Config = { baseUrl: string; token: string };
const fail = (code: string, message: string, status = 502): never => { throw new SharedMemoryError(code, message, status); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const revision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const at = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const protocol = (): never => fail('xinchao_protocol', '心潮返回格式与已核对的4.3.0接口不符，请检查部署版本。');

export function readXinchaoConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const base = env.FLOAT_XINCHAO_URL?.trim(), token = env.DYNAMIC_MIND_TOKEN?.trim();
    if (!base || !token) return fail('xinchao_unconfigured', '心潮连接尚未配置；请由部署端配置服务地址和令牌。', 503);
    if (env.FLOAT_XINCHAO_REST_CONTRACT !== XINCHAO_CONTRACT) return fail('xinchao_unverified', '部署端尚未确认实际4.3.0源码与此适配一致。', 503);
    let url: URL;
    try { url = new URL(base); } catch { return fail('xinchao_config', '心潮服务端地址配置无效。', 503); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && env.FLOAT_XINCHAO_ALLOW_HTTP === 'true'))
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || token.length < 32 || token.length > 512 || /[\x00-\x20\x7f]/.test(token)) return fail('xinchao_config', '心潮服务端连接配置无效。', 503);
    return { baseUrl: url.origin, token };
}

async function readJson(response: Response): Promise<unknown> {
    if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) return fail('xinchao_auth', '心潮服务令牌未通过验证。');
        return fail('xinchao_unavailable', '心潮服务暂时不可用，请稍后重试。');
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); return protocol(); }
    const reader = response.body?.getReader();
    if (!reader) return protocol();
    let raw = '', bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        while (true) {
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 2 * 1024 * 1024) { await reader.cancel(); return fail('xinchao_size', '心潮响应超出读取上限。'); }
            raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
        return JSON.parse(raw);
    } catch (error) {
        if (error instanceof SharedMemoryError) throw error;
        return protocol();
    } finally { reader.releaseLock(); }
}

/** Fixed read-only requests. No dashboard cookies, arbitrary URLs, mutation or model call. */
function createReader(config: Config, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    return async (path: '/health' | '/v1/state' | '/v1/now') => {
        let response: Response;
        try { response = await fetcher(config.baseUrl + path, { method: 'GET', headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: requestSignal }); }
        catch { return fail('xinchao_unreachable', '心潮连接未完成，请检查服务或稍后重试。'); }
        return readJson(response);
    };
}
async function verifyHealth(get: ReturnType<typeof createReader>) {
    const health = await get('/health');
    if (!object(health) || health.ok !== true || health.system !== 'xinchao-dynamic-mind' || health.version !== '4.3.0') return fail('xinchao_version', '当前心潮版本尚未适配；本入口仅支持已核对的4.3.0。');
}
export async function checkXinchaoHealth(config: Config, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
    await verifyHealth(createReader(config, signal, fetcher));
}
function projectNow(now: unknown): XinchaoSnapshot['now'] {
    if (!object(now) || typeof now.ok !== 'boolean' || typeof now.text !== 'string' || now.text.length > 16000
        || !revision(now.revision) || !at(now.generatedAt) || (now.ok && !now.text.trim())
        || (!now.ok && (now.text !== '' || typeof now.reason !== 'string' || now.reason.length > 100))) return protocol();
    return { available: now.ok, text: now.text, reason: now.ok ? null : String(now.reason), generatedAt: now.generatedAt, revision: now.revision };
}
export async function readXinchaoNow(config: Config, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<XinchaoSnapshot['now']> {
    const get = createReader(config, signal, fetcher);
    await verifyHealth(get);
    return projectNow(await get('/v1/now'));
}
/** Content-free ordinary conversation; fixed companionship skips classifier models. */
export async function recordXinchaoPresence(config: Config, eventId: string, sessionId: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<{ revision: number; duplicate: boolean }> {
    if (![eventId, sessionId].every(value => /^float:[a-f0-9]{64}$/.test(value))) return fail('xinchao_feedback_input', '反馈标识无效。', 400);
    const requestSignal = AbortSignal.any([AbortSignal.timeout(2200), ...(signal ? [signal] : [])]);
    await verifyHealth(createReader(config, requestSignal, fetcher));
    requestSignal.throwIfAborted();
    let response: Response;
    try { response = await fetcher(config.baseUrl + '/v1/conversation-event', { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ eventId, sessionId, interactionType: 'companionship' }), cache: 'no-store', redirect: 'error', signal: requestSignal }); }
    catch { return fail('xinchao_feedback_unconfirmed', '对话反馈未确认，未自动重试。'); }
    const value = await readJson(response);
    if (!object(value) || !revision(value.revision) || typeof value.duplicate !== 'boolean') return protocol();
    return { revision: value.revision, duplicate: value.duplicate };
}
export async function readXinchaoSnapshot(config: Config, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<XinchaoSnapshot> {
    const get = createReader(config, signal, fetcher);
    await verifyHealth(get);
    const [state, now] = await Promise.all([get('/v1/state'), get('/v1/now')]);
    if (!object(state) || state.schemaVersion !== 10 || !revision(state.revision) || typeof state.consciousness !== 'string'
        || !/^[a-z_]{1,32}$/.test(state.consciousness) || !object(state.drives)
        || (state.lastSettledAt != null && !at(state.lastSettledAt))) return protocol();
    const projectedNow = projectNow(now);
    // Neutral dimensions only. No body/intimacy activation and no inferred relationship labels.
    const labels: Record<string, string> = { curiosity: '好奇', boredom: '闲暇', duty: '行动意愿', reflection: '自省', grieve: '低落', anger: '不满' };
    const currentDrives = state.drives;
    const drives = Object.entries(labels).flatMap(([key, label]) => {
        const value = currentDrives[key];
        if (value === undefined) return [];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return protocol();
        return [{ key, label, value }];
    });
    return { version: '4.3.0', revision: state.revision, fetchedAt: new Date().toISOString(), consciousness: state.consciousness,
        lastSettledAt: at(state.lastSettledAt) ? state.lastSettledAt : null, drives,
        now: projectedNow };
}
