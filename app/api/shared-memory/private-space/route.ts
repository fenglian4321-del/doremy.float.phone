import { createHash } from 'node:crypto';
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
        const payload = { ...body as Record<string, unknown> }; delete payload._externalClient;
        if (request.headers.get('x-float-space-external-tools') === 'v1') payload._externalClient = 'v1';
        if (payload.operation === 'phone_lease') {
            if (payload._externalClient !== 'v1' || Object.keys(payload).sort().join(',') !== '_externalClient,claim,operation,runId,workspaceId'
                || !['workspaceId', 'runId'].every(key => typeof payload[key] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(payload[key] as string))
                || typeof payload.claim !== 'string' || !/^[^\x00-\x20\x7f]{1,160}$/.test(payload.claim)) throw new SharedMemoryError('invalid_request', '手机任务租约标识无效。', 400);
            const state = await createOmbreReviewClient(config).privateSpaces({ ...payload, operation: 'heartbeat' });
            const run = state.run as { id?: string; state?: string; executionVersion?: number; externalMode?: string } | undefined;
            const space = state.workspace as { id?: string; mode?: string } | undefined;
            if (!run || run.id !== payload.runId || run.state !== 'running' || run.executionVersion !== 1 || !['phone', 'assistant'].includes(run.externalMode || '') || space?.id !== payload.workspaceId || space?.mode !== 'private') throw new SharedMemoryError('work_inactive', '原手机任务已停止、失效或执行位置不符。', 409);
            const messages = (state.workspace as { messages?: { id?: string; role?: string; content?: string }[] }).messages;
            const task = Array.isArray(messages) ? messages.find(message => message.id === 'u_' + run.id && message.role === 'user') : undefined;
            if (typeof task?.content !== 'string') throw new SharedMemoryError('work_inactive', '原手机任务文字不可核对。', 409);
            const taskDigest = createHash('sha256').update(task.content, 'utf8').digest('hex');
            return NextResponse.json({ ok: true, protocol: 'float-shell-ui-lease/v1', taskDigest, runId: run.id, scope: { mode: 'private', workspaceId: payload.workspaceId }, executionVersion: 1, externalMode: run.externalMode, state: 'running' }, { headers });
        }
        const result = await createOmbreReviewClient(config).privateSpaces(payload);
        if (result.run && typeof result.run === 'object' && 'kind' in result.run && result.run.kind === 'compression' && request.headers.get('x-float-space-context') !== 'v1') throw new SharedMemoryError('work_client_upgrade', '当前记录包含摘要任务，请刷新页面更新客户端后恢复，未请求模型。', 409);
        return NextResponse.json(result, { headers });
    } catch (error) {
        const known = error instanceof SharedMemoryError;
        return NextResponse.json({ ok: false, code: known ? error.code : 'internal', error: known ? error.message : '私人空间操作未确认，请刷新同一任务，勿重复新建。' }, { status: known ? error.status : 500, headers });
    }
}
