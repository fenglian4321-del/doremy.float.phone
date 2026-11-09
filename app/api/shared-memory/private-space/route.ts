import { NextResponse } from 'next/server';
import { authorizeSharedMemory, readSharedMemoryConfig, sharedMemoryRequestOrigin, SharedMemoryError } from '@/lib/server/shared-memory';
import { createOmbreReviewClient } from '@/lib/server/shared-memory-review';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, x-float-memory-access-token', 'X-Content-Type-Options': 'nosniff' };
export async function POST(request: Request) {
    try {
        if (request.headers.get('origin') !== sharedMemoryRequestOrigin(request) || request.headers.get('sec-fetch-site') === 'cross-site') throw new SharedMemoryError('forbidden', '私人空间仅允许本站本人访问。', 403);
        const config = readSharedMemoryConfig();
        if (!config || !authorizeSharedMemory(request, config)) throw new SharedMemoryError('unauthorized', '请先验证本人会话。', 401);
        const reader = request.body?.getReader();
        if (!reader) throw new SharedMemoryError('invalid_request', '私人空间请求为空。', 400);
        const decoder = new TextDecoder(); let raw = '', size = 0;
        try {
            while (true) {
                const chunk = await reader.read(); if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > 128 * 1024) { await reader.cancel(); throw new SharedMemoryError('too_large', '私人空间请求超过128KiB，未截断。', 413); }
                raw += decoder.decode(chunk.value, { stream: true });
            }
            raw += decoder.decode();
        } finally { reader.releaseLock(); }
        let body: unknown;
        try { body = JSON.parse(raw); } catch { throw new SharedMemoryError('invalid_request', '私人空间 JSON 无效。', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SharedMemoryError('invalid_request', '私人空间请求格式无效。', 400);
        const result = await createOmbreReviewClient(config).privateSpaces(body as Record<string, unknown>);
        if (result.run && typeof result.run === 'object' && 'kind' in result.run && result.run.kind === 'compression' && request.headers.get('x-float-space-context') !== 'v1') throw new SharedMemoryError('work_client_upgrade', '当前记录包含摘要任务，请刷新页面更新客户端后恢复，未请求模型。', 409);
        return NextResponse.json(result, { headers });
    } catch (error) {
        const known = error instanceof SharedMemoryError;
        return NextResponse.json({ ok: false, code: known ? error.code : 'internal', error: known ? error.message : '私人空间操作未确认，请刷新同一任务，勿重复新建。' }, { status: known ? error.status : 500, headers });
    }
}
