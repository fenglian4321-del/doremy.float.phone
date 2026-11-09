import { authorizeSharedMemory, readSharedMemoryConfig, sharedMemoryRequestOrigin, SharedMemoryError } from './shared-memory';
import { createXinchaoProactiveInbox, readXinchaoProactiveInboxConfig } from './xinchao-proactive-inbox';
export const xinchaoProactiveHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, x-float-memory-access-token', 'X-Content-Type-Options': 'nosniff' };
export function xinchaoProactiveOwner(request: Request, stateOnly = false) {
    const origin = sharedMemoryRequestOrigin(request), owner = readSharedMemoryConfig();
    if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new SharedMemoryError('forbidden', '心潮主动入口仅允许本站本人使用。', 403);
    if (!owner || !authorizeSharedMemory(request, owner)) throw new SharedMemoryError('unauthorized', '请先验证本人会话。', 401);
    const config = readXinchaoProactiveInboxConfig(process.env, stateOnly);
    if (!config) return { origin, config: null, inbox: null };
    if ([owner.accessToken, owner.password, owner.reviewToken].filter(Boolean).includes(config.key) || (config.bridge && [owner.accessToken, owner.password, owner.reviewToken].filter(Boolean).includes(config.bridge.token))) throw new SharedMemoryError('xinchao_inbox_config', '主动入口需独立账本与桥凭据。', 503);
    return { origin, config, inbox: createXinchaoProactiveInbox(config, origin) };
}
export async function xinchaoProactiveBody(request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader(); if (!reader) throw new SharedMemoryError('invalid_request', '缺少主动入口操作。', 400);
    const cancel = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder('utf-8', { fatal: true }); let raw = '', bytes = 0;
    try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 16384) throw new SharedMemoryError('invalid_request', '主动操作参数超过容量。', 413); raw += decoder.decode(part.value, { stream: true }); } signal.throwIfAborted(); raw += decoder.decode(); const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
    catch (error) { if (error instanceof SharedMemoryError) throw error; throw new SharedMemoryError('invalid_request', '主动操作参数无效。', 400); }
    finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function xinchaoProactiveError(error: unknown) {
    const known = error instanceof SharedMemoryError;
    return { body: { ok: false, code: known ? error.code : 'internal', error: known ? error.message : '心潮主动操作未确认，未自动重做模型。' }, status: known ? error.status : 503 };
}
