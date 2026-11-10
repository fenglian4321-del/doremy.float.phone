import { NextResponse } from 'next/server';
import {
    authorizeSharedMemory,
    readSharedMemoryConfig,
    sharedMemoryRequestOrigin,
    SharedMemoryError,
} from '@/lib/server/shared-memory';
import { createXinchaoInner } from '@/lib/server/xinchao-inner';
import { INNER_MODULES, type InnerModule, type InnerAction } from '@/lib/xinchao-inner-types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = {
    'Cache-Control': 'private, no-store',
    Vary: 'Cookie, x-float-memory-access-token',
    'X-Content-Type-Options': 'nosniff',
};
export async function POST(request: Request) {
    try {
        if (
            request.headers.get('origin') !== sharedMemoryRequestOrigin(request) ||
            request.headers.get('sec-fetch-site') === 'cross-site'
        )
            throw new SharedMemoryError('forbidden', '仅允许本站本人访问。', 403);
        const owner = readSharedMemoryConfig();
        if (!owner || !authorizeSharedMemory(request, owner))
            throw new SharedMemoryError('unauthorized', '请先验证本人会话。', 401);
        const reader = request.body?.getReader();
        if (!reader) throw new SharedMemoryError('invalid_request', '请求为空。', 400);
        let size = 0,
            raw = '';
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
            while (true) {
                const p = await reader.read();
                if (p.done) break;
                size += p.value.byteLength;
                if (size > 32768) throw new SharedMemoryError('invalid_request', '请求超过容量。', 400);
                raw += decoder.decode(p.value, { stream: true });
            }
            raw += decoder.decode();
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        const b = JSON.parse(raw);
        if (!b || typeof b !== 'object' || Array.isArray(b))
            throw new SharedMemoryError('invalid_request', '请求无效。', 400);
        const fields: Record<string, string[]> = {
            read: ['operation', 'module'],
            mutate: ['operation', 'requestId', 'revision', 'input'],
            receipt: ['operation', 'requestId'],
            tool: ['operation', 'requestId', 'context', 'args'],
        };
        if (!fields[b.operation] || Object.keys(b).sort().join() !== fields[b.operation].sort().join())
            throw new SharedMemoryError('invalid_request', '请求参数无效。', 400);
        const api = createXinchaoInner();
        let result;
        if (b.operation === 'read') {
            if (!INNER_MODULES.includes(b.module))
                throw new SharedMemoryError('invalid_request', '模块无效。', 400);
            result = { document: await api.read(b.module as InnerModule, request.signal) };
        } else if (b.operation === 'mutate')
            result = await api.mutate(b.requestId, b.revision, b.input as InnerAction, request.signal);
        else if (b.operation === 'receipt') result = await api.receipt(b.requestId, request.signal);
        else
            result = await api.tool(
                { requestId: b.requestId, context: b.context, args: b.args },
                request.signal,
            );
        return NextResponse.json({ ok: true, protocol: 'float-xinchao-inner/v1', ...result }, { headers });
    } catch (e) {
        const known = e instanceof SharedMemoryError;
        return NextResponse.json(
            {
                ok: false,
                code: known ? e.code : 'inner_error',
                error: known ? e.message : '内室操作未完成，请核对结果后重试。',
            },
            { status: known ? e.status : 500, headers },
        );
    }
}
