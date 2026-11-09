import { NextResponse } from 'next/server';
import { authorizeSharedMemory, readSharedMemoryConfig, sharedMemoryRequestOrigin, SharedMemoryError } from '@/lib/server/shared-memory';
import { readXinchaoConfig, readXinchaoNow } from '@/lib/server/xinchao';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, x-float-memory-access-token', 'X-Content-Type-Options': 'nosniff' };
export async function POST(request: Request) {
    try {
        if (request.headers.get('origin') !== sharedMemoryRequestOrigin(request) || request.headers.get('sec-fetch-site') === 'cross-site') throw new SharedMemoryError('forbidden', '心潮仅允许本站本人访问。', 403);
        const owner = readSharedMemoryConfig();
        if (!owner || !authorizeSharedMemory(request, owner)) throw new SharedMemoryError('unauthorized', '请先验证本人会话。', 401);
        // This endpoint has one operation and accepts no client URL, path, token or body.
        if (request.body) {
            const reader = request.body.getReader();
            try { const first = await reader.read(); if (!first.done) { await reader.cancel(); throw new SharedMemoryError('invalid_request', '心潮只读刷新不接受操作参数。', 400); } }
            finally { reader.releaseLock(); }
        }
        const now = await readXinchaoNow(readXinchaoConfig(), AbortSignal.any([request.signal, AbortSignal.timeout(2400)]));
        return NextResponse.json({ ok: true, protocol: 'float-xinchao-now/v1', now }, { headers });
    } catch (error) {
        const known = error instanceof SharedMemoryError;
        return NextResponse.json({ ok: false, code: known ? error.code : 'internal', error: known ? error.message : '心潮读取失败，请稍后重试。' }, { status: known ? error.status : 500, headers });
    }
}
