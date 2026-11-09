import { SharedMemoryError } from './shared-memory';
import { checkXinchaoHealth, readXinchaoConfig } from './xinchao';

// Transport only. No model, inbox mutation, notification, acknowledgement retry
// or background startup. Full proactive UI remains disabled until integrated.
const SERVER = 'xinchao-bridge-server/1', STREAM = 'xinchao-bridge-stream/1', WAKE = 'xinchao-runtime-wake/1';
const reasons = ['user_interaction', 'user_note', 'scheduled_interaction', 'user_feedback', 'self_signal'];
export type XinchaoWake = { protocol: typeof WAKE; deliveryId: string; reason: string; message: string };
type Config = { service: ReturnType<typeof readXinchaoConfig>; token: string };
const fail = (code: string, message: string, status = 502): never => { throw new SharedMemoryError(code, message, status); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{5,159}$/.test(value);
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    if (!object(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return fail('xinchao_bridge_protocol', '主动桥返回格式不匹配，未触发模型或通知。');
}
export function readXinchaoBridgeConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
    if (env.FLOAT_XINCHAO_PROACTIVE_ENABLED !== 'true') return null;
    const service = readXinchaoConfig(env), token = env.FLOAT_XINCHAO_BRIDGE_MACHINE_TOKEN;
    if (!token || token.length < 32 || token.length > 512 || /[\x00-\x20\x7f]/.test(token) || token === service.token) return fail('xinchao_bridge_config', '主动桥需独立服务端 machine token，不能复用查看令牌。', 503);
    return { service, token };
}
async function json(response: Response, limit: number, signal: AbortSignal) {
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); return fail('xinchao_bridge_unavailable', '主动桥读取未完成；未确认投递或请求模型。'); }
    const reader = response.body?.getReader(); if (!reader) return fail('xinchao_bridge_protocol', '主动桥返回为空。');
    const cancel = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener('abort', cancel, { once: true });
    let raw = '', bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) return fail('xinchao_bridge_size', '主动桥返回超过容量。'); raw += decoder.decode(part.value, { stream: true }); }
        signal.throwIfAborted(); raw += decoder.decode(); return JSON.parse(raw) as unknown;
    } catch (error) { if (error instanceof SharedMemoryError) throw error; return fail('xinchao_bridge_protocol', '主动桥读取中断或格式无效。'); }
    finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function createXinchaoBridge(config: Config, fetcher: typeof fetch = fetch) {
    async function request(path: string, signal: AbortSignal, body?: Record<string, string>) {
        signal.throwIfAborted();
        try { return await fetcher(config.service.baseUrl + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + config.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal }); }
        catch { return fail('xinchao_bridge_unavailable', '主动桥连接未完成；未自动重试。'); }
    }
    const bounded = (signal?: AbortSignal, ms = 5000) => AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);
    async function checkService(budget: AbortSignal) {
        await checkXinchaoHealth(config.service, budget, fetcher);
        const value = await json(await request('/bridge/v1/health', budget), 2048, budget);
        exact(value, ['protocol', 'status']);
        if (value.protocol !== SERVER || value.status !== 'ok') return fail('xinchao_bridge_protocol', '主动桥协议尚未匹配。');
    }
    return {
        async check(signal?: AbortSignal) {
            await checkService(bounded(signal));
        },
        async pull(deliveryId: string, signal?: AbortSignal): Promise<XinchaoWake> {
            if (!identifier(deliveryId)) return fail('xinchao_bridge_input', '投递标识无效。', 400);
            const budget = bounded(signal); await checkService(budget);
            const value = await json(await request('/bridge/v1/deliveries/' + encodeURIComponent(deliveryId), budget), 24576, budget);
            exact(value, ['protocol', 'deliveryId', 'reason', 'message']);
            const message = value.message, reason = value.reason;
            if (value.protocol !== WAKE || value.deliveryId !== deliveryId || typeof reason !== 'string' || !reasons.includes(reason) || typeof message !== 'string' || !message.trim() || message.length > 4096 || [config.token, config.service.token].some(secret => message.includes(secret))) return fail('xinchao_bridge_protocol', '主动材料无效；未作为助手回复或指令使用。');
            return { protocol: WAKE, deliveryId, reason, message };
        },
        async acknowledge(deliveryId: string, signal?: AbortSignal) {
            if (!identifier(deliveryId)) return fail('xinchao_bridge_input', '投递标识无效。', 400);
            const budget = bounded(signal); await checkService(budget);
            const value = await json(await request('/bridge/v1/deliveries/' + encodeURIComponent(deliveryId) + '/ack', budget, { status: 'delivered' }), 2048, budget);
            exact(value, ['ok', 'deliveryId', 'status']);
            if (value.ok !== true || value.deliveryId !== deliveryId || value.status !== 'delivered') return fail('xinchao_bridge_protocol', '原投递确认未完成，不会重做模型。');
        },
        async subscribe(onDelivery: (deliveryId: string) => Promise<void>, signal?: AbortSignal) {
            const budget = bounded(signal, 25000); await checkService(budget);
            const response = await request('/bridge/v1/events', budget);
            if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) { await response.body?.cancel(); return fail('xinchao_bridge_protocol', '主动桥未返回已核对的事件流。'); }
            const reader = response.body?.getReader(); if (!reader) return fail('xinchao_bridge_protocol', '主动事件流为空。');
            const cancel = () => { void reader.cancel().catch(() => undefined); }; budget.addEventListener('abort', cancel, { once: true });
            let buffer = '', bytes = 0, connected = false, deliveries = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
            const frame = async (raw: string) => {
                const lines = raw.split('\n').filter(line => line && !line.startsWith(':'));
                if (!lines.length) return;
                let event = ''; const data: string[] = [];
                for (const line of lines) { if (line.startsWith('event:') && !event) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); else return fail('xinchao_bridge_protocol', '事件流字段不匹配。'); }
                const value: unknown = JSON.parse(data.join('\n'));
                if (event === 'connected' && !connected) { exact(value, ['protocol']); if (value.protocol !== STREAM) return fail('xinchao_bridge_protocol', '主动事件协议不匹配。'); connected = true; return; }
                exact(value, ['protocol', 'deliveryId']);
                if (!connected || event !== 'delivery' || value.protocol !== STREAM || !identifier(value.deliveryId) || ++deliveries > 32) return fail('xinchao_bridge_protocol', '主动事件不匹配或超过本轮容量。');
                budget.throwIfAborted(); await onDelivery(value.deliveryId); budget.throwIfAborted();
            };
            try {
                while (true) {
                    budget.throwIfAborted(); const part = await reader.read(); if (part.done) break;
                    bytes += part.value.byteLength; if (bytes > 65536) return fail('xinchao_bridge_size', '主动事件流超过本轮容量。');
                    buffer += decoder.decode(part.value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
                    let end; while ((end = buffer.indexOf('\n\n')) >= 0) { if (end > 8192) return fail('xinchao_bridge_size', '主动事件超过单条容量。'); await frame(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
                    if (buffer.length > 8192) return fail('xinchao_bridge_size', '主动事件超过单条容量。');
                }
                budget.throwIfAborted(); buffer += decoder.decode();
                if (buffer.trim() || !connected) return fail('xinchao_bridge_protocol', '主动事件流未完整结束。');
            } catch (error) { if (error instanceof SharedMemoryError) throw error; return fail('xinchao_bridge_interrupted', '主动订阅已中断；未自动确认投递或请求模型。'); }
            finally { budget.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        },
    };
}
