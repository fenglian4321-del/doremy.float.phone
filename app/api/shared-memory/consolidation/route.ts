import { NextResponse } from 'next/server';
import { authorizeSharedMemory, readSharedMemoryConfig, sharedMemoryRequestOrigin, SharedMemoryError } from '@/lib/server/shared-memory';
import { createOmbreReviewClient } from '@/lib/server/shared-memory-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, x-float-memory-access-token', 'X-Content-Type-Options': 'nosniff' };
export async function POST(request: Request) {
    try {
        if (request.headers.get('origin') !== sharedMemoryRequestOrigin(request) || request.headers.get('sec-fetch-site') === 'cross-site') throw new SharedMemoryError('forbidden', '整理操作只允许本站本人访问。', 403);
        const config = readSharedMemoryConfig();
        if (!config || !authorizeSharedMemory(request, config)) throw new SharedMemoryError('unauthorized', '请先验证共享记忆本人会话。', 401);
        const reader = request.body?.getReader();
        if (!reader) throw new SharedMemoryError('invalid_request', '整理请求为空。', 400);
        const decoder = new TextDecoder(); let raw = '', size = 0;
        try {
            while (true) {
                const chunk = await reader.read(); if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > 256 * 1024) { await reader.cancel(); throw new SharedMemoryError('too_large', '本批原文超过256 KiB，未截断提交。', 413); }
                raw += decoder.decode(chunk.value, { stream: true });
            }
            raw += decoder.decode();
        } finally { reader.releaseLock(); }
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch { throw new SharedMemoryError('invalid_request', '整理 JSON 无效。', 400); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SharedMemoryError('invalid_request', '整理请求格式无效。', 400);
        return NextResponse.json(await createOmbreReviewClient(config).consolidation(payload as Record<string, unknown>), { headers });
    } catch (error) {
        const known = error instanceof SharedMemoryError;
        return NextResponse.json({ ok: false, code: known ? error.code : 'internal', error: known ? error.message : '整理操作未确认，进度仍保留；请刷新同一任务。' }, { status: known ? error.status : 500, headers });
    }
}
