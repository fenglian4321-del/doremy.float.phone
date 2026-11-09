import { NextResponse } from 'next/server';
import { authorizeSharedMemory, readSharedMemoryConfig, sharedMemoryRequestOrigin, SharedMemoryError } from '@/lib/server/shared-memory';
import { createOmbreReviewClient } from '@/lib/server/shared-memory-review';
import { createManagedMcpGateway, readManagedMcpConfig } from '@/lib/server/managed-mcp';
import { MANAGED_MCP_PROTOCOL, ManagedMcpError, mcpExact, mcpScope, mcpObject, mcpId } from '@/lib/managed-mcp-policy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, x-float-memory-access-token', 'X-Content-Type-Options': 'nosniff' };
export async function POST(request: Request) {
    try {
        const budget = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
        const origin = sharedMemoryRequestOrigin(request);
        if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new ManagedMcpError('forbidden', '受控MCP仅允许本站本人操作。', 403);
        const owner = readSharedMemoryConfig();
        if (!owner || !authorizeSharedMemory(request, owner)) throw new ManagedMcpError('unauthorized', '请先验证本人会话。', 401);
        if (!request.headers.get('content-type')?.includes('application/json')) throw new ManagedMcpError('schema');
        const reader = request.body?.getReader(); if (!reader) throw new ManagedMcpError('schema');
        let raw = '', size = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
        const abort = () => { void reader.cancel().catch(() => undefined); }; budget.addEventListener('abort', abort, { once: true });
        try { while (true) { budget.throwIfAborted(); const chunk = await reader.read(); budget.throwIfAborted(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 32768) { await reader.cancel(); throw new ManagedMcpError('capacity', '受控MCP请求超过32KiB。', 413); } raw += decoder.decode(chunk.value, { stream: true }); } raw += decoder.decode(); } finally { budget.removeEventListener('abort', abort); reader.releaseLock(); }
        let body: unknown; try { body = JSON.parse(raw); } catch { throw new ManagedMcpError('schema', '受控MCP请求不是有效JSON。'); }
        mcpExact(body, ['operation', 'scope', 'version', 'enabled', 'services', 'serviceId', 'tool', 'args', 'requestId', 'run']); mcpScope(body.scope);
        if (body.run !== undefined) { mcpExact(body.run, ['runId', 'claim']); mcpId(body.run.runId); mcpId(body.run.claim); }
        const config = readManagedMcpConfig();
        if (!config) {
            if (body.operation !== 'catalog') throw new ManagedMcpError('disabled', '管理员尚未启用受控MCP；没有连接服务。', 503);
            return NextResponse.json({ protocol: MANAGED_MCP_PROTOCOL, available: false, services: [], binding: { version: 0, enabled: false, services: [] } }, { headers });
        }
        const ownerSecrets = [owner.accessToken, owner.password, owner.reviewToken].filter((value): value is string => !!value);
        const publicCatalog = JSON.stringify(config.services.map(({ id, name, revision, tools }) => ({ id, name, revision, tools })));
        if ([config.key, ...config.services.map(service => service.token).filter(Boolean)].some(value => ownerSecrets.includes(value)) || ownerSecrets.some(value => value.length >= 16 && publicCatalog.includes(value))) throw new ManagedMcpError('configuration', '受控MCP必须使用独立服务凭据，不能复用本人或记忆服务口令。', 503);
        const handler = createManagedMcpGateway(config, origin, async scope => {
            const client = createOmbreReviewClient(owner);
            const state = await (scope.mode === 'work' ? client.workspaces({ operation: 'detail', workspaceId: scope.workspaceId, _externalClient: 'v1' }) : client.privateSpaces({ operation: 'detail', workspaceId: scope.workspaceId, _externalClient: 'v1' }));
            const workspace = state.workspace as { id?: string; mode?: string; archived?: boolean } | undefined;
            if (!workspace || workspace.id !== scope.workspaceId || workspace.mode !== scope.mode) throw new ManagedMcpError('scope', '空间不存在或范围不匹配。', 403);
            if (workspace.archived && !['catalog', 'receipt', 'cancel'].includes(String(body.operation)) && !(body.operation === 'bind' && body.enabled === false)) throw new ManagedMcpError('archived', '归档空间不能授权或新建外部调用。', 403);
            if (mcpObject(body.run)) {
                const heartbeat = { operation: 'heartbeat', workspaceId: scope.workspaceId, runId: body.run.runId, claim: body.run.claim, _externalClient: 'v1' };
                const current = await (scope.mode === 'work' ? client.workspaces(heartbeat) : client.privateSpaces(heartbeat));
                const run = current.run as { id?: string; executionVersion?: number; externalMode?: string; state?: string } | undefined;
                if (!run || run.id !== body.run.runId || run.executionVersion !== 1 || !['mcp', 'assistant'].includes(run.externalMode || '') || run.state !== 'running') throw new ManagedMcpError('run_inactive', '原聊天工具轮已停止或被接管。', 409);
            }
        });
        const result = await handler(body, budget);
        return NextResponse.json(result, { headers });
    } catch (error) {
        const known = error instanceof ManagedMcpError;
        const ownerError = error instanceof SharedMemoryError;
        const timeout = error instanceof DOMException && error.name === 'TimeoutError';
        // Never expose MCP URLs, headers, arguments, remote errors or results in diagnostics.
        return NextResponse.json({ ok: false, code: known ? error.code : timeout ? 'timeout' : ownerError ? 'scope_unavailable' : 'unconfirmed', error: known ? error.message : '受控MCP未确认，请核对原回执；没有自动重复调用。' }, { status: known ? error.status : timeout ? 504 : ownerError ? 503 : 502, headers });
    }
}
