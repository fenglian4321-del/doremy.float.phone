import { NextResponse } from 'next/server';
import { authorizeSharedMemory, readSharedMemoryConfig, sharedMemoryRequestOrigin, SharedMemoryError } from '@/lib/server/shared-memory';
import { callCodexProxy, readCodexJson, readCodexProxyConfig } from '@/lib/server/codex-gateway';
import { CodexGatewayError } from '@/lib/codex-gateway-policy.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, x-float-memory-access-token', 'X-Content-Type-Options': 'nosniff' };
async function handle(request: Request, post: boolean) {
    try {
        const origin = request.headers.get('origin');
        const expectedOrigin = sharedMemoryRequestOrigin(request);
        if ((post && origin !== expectedOrigin) || (origin && origin !== expectedOrigin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new CodexGatewayError('forbidden', '工具网关只允许本站本人访问。', 403);
        const owner = readSharedMemoryConfig();
        if (!owner || !authorizeSharedMemory(request, owner)) throw new CodexGatewayError('unauthorized', '请先在上方共享记忆面板验证本人会话。', 401);
        const config = readCodexProxyConfig();
        if (!config) throw new CodexGatewayError('unconfigured', '服务端尚未配置 Codex 工具网关。', 503);
        let call: unknown;
        if (post) {
            // Reuse the bounded JSON reader with a smaller request cap before parsing.
            const reader = request.body?.getReader(); if (!reader) throw new CodexGatewayError('invalid_request', '工具请求为空。', 400);
            const chunks: Uint8Array[] = []; let size = 0;
            try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 8192) { await reader.cancel(); throw new CodexGatewayError('too_large', '工具请求超过容量。', 413); } chunks.push(next.value); } } finally { reader.releaseLock(); }
            call = await readCodexJson(new Response(new Blob(chunks as BlobPart[]), { headers: { 'Content-Type': 'application/json' } }));
        }
        const result = await callCodexProxy(config, request.signal, call);
        return NextResponse.json({ ok: true, ...result }, { headers });
    } catch (error) {
        const known = error instanceof CodexGatewayError || error instanceof SharedMemoryError;
        return NextResponse.json({ ok: false, code: known ? error.code : 'internal', error: known ? error.message : '工具网关调用失败。' }, { status: known ? error.status : 500, headers });
    }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
