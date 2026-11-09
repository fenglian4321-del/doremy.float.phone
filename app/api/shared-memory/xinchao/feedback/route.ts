import { NextResponse } from 'next/server';
import { authorizeSharedMemory, readSharedMemoryConfig, sharedMemoryRequestOrigin, SharedMemoryError } from '@/lib/server/shared-memory';
import { createXinchaoFeedback, readXinchaoFeedbackConfig, xinchaoFeedbackTurn } from '@/lib/server/xinchao-feedback';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, x-float-memory-access-token', 'X-Content-Type-Options': 'nosniff' };
export async function POST(request: Request) {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
    try {
        const origin = sharedMemoryRequestOrigin(request);
        if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new SharedMemoryError('forbidden', '心潮仅允许本站本人访问。', 403);
        const owner = readSharedMemoryConfig();
        if (!owner || !authorizeSharedMemory(request, owner)) throw new SharedMemoryError('unauthorized', '请先验证本人会话。', 401);
        const reader = request.body?.getReader();
        if (!reader) throw new SharedMemoryError('invalid_request', '缺少反馈操作。', 400);
        const cancel = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener('abort', cancel, { once: true });
        let raw = '', bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
        try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 4096) throw new SharedMemoryError('invalid_request', '反馈参数超过容量。', 413); raw += decoder.decode(part.value, { stream: true }); } raw += decoder.decode(); }
        finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        let body; try { body = JSON.parse(raw); } catch { throw new SharedMemoryError('invalid_request', '反馈参数无效。', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['operation', 'turn'].includes(key)) || !['catalog', 'record', 'status'].includes(body.operation) || (body.operation === 'catalog' && body.turn !== undefined)) throw new SharedMemoryError('invalid_request', '只提供固定对话反馈操作。', 400);
        const config = readXinchaoFeedbackConfig();
        if (body.operation === 'catalog') return NextResponse.json({ ok: true, protocol: 'float-xinchao-feedback/v1', available: !!config }, { headers });
        if (!config) throw new SharedMemoryError('xinchao_feedback_disabled', '服务端尚未启用对话反馈，聊天照常继续。', 503);
        if ([owner.accessToken, owner.password, owner.reviewToken].filter(Boolean).includes(config.key)) throw new SharedMemoryError('xinchao_feedback_config', '反馈回执需独立密钥。', 503);
        xinchaoFeedbackTurn(body.turn);
        const result = await createXinchaoFeedback(config, origin)(body.operation, body.turn, signal);
        return NextResponse.json({ ok: true, protocol: 'float-xinchao-feedback/v1', available: true, ...result }, { headers });
    } catch (error) {
        const known = error instanceof SharedMemoryError;
        return NextResponse.json({ ok: false, code: known ? error.code : 'internal', error: known ? error.message : '反馈未确认，聊天照常继续；未自动重试。' }, { status: known ? error.status : 503, headers });
    }
}
