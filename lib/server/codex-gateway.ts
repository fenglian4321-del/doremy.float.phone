import { CODEX_GATEWAY_PROTOCOL, CODEX_GATEWAY_TOOLS, CodexGatewayError, isObject, validateCodexCall } from '../codex-gateway-policy.mjs';

export function readCodexProxyConfig(env: NodeJS.ProcessEnv = process.env) {
    const address = env.FLOAT_CODEX_GATEWAY_URL?.trim(), token = env.FLOAT_CODEX_GATEWAY_TOKEN;
    if (!address || !token) return null;
    let url: URL; try { url = new URL(address); } catch { throw new CodexGatewayError('configuration', 'Codex 网关地址无效。', 503); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.FLOAT_CODEX_GATEWAY_ALLOW_HTTP === 'true'))
        || token.length < 32 || token.length > 512 || token === env.FLOAT_SHARED_MEMORY_ACCESS_TOKEN || token === env.FLOAT_SHARED_MEMORY_REVIEW_TOKEN || token === env.FLOAT_SHARED_MEMORY_OMBRE_PASSWORD) throw new CodexGatewayError('configuration', 'Codex 网关须使用独立服务端凭据与受控地址。', 503);
    return { origin: url.origin, token };
}
export async function readCodexJson(response: Response) {
    if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new CodexGatewayError('protocol', 'Codex 网关返回格式不兼容。'); }
    const reader = response.body?.getReader(); if (!reader) throw new CodexGatewayError('protocol', 'Codex 网关未返回数据。');
    let size = 0, raw = ''; const decoder = new TextDecoder();
    try {
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
            if (size > 64 * 1024) { await reader.cancel(); throw new CodexGatewayError('too_large', 'Codex 结果超出容量，未截断正文。', 413); }
            raw += decoder.decode(next.value, { stream: true }); }
        raw += decoder.decode();
    } finally { reader.releaseLock(); }
    try { const body: unknown = JSON.parse(raw); if (!isObject(body)) throw new Error(); return body; }
    catch { throw new CodexGatewayError('protocol', 'Codex 网关返回了无效数据。'); }
}
export async function callCodexProxy(config: NonNullable<ReturnType<typeof readCodexProxyConfig>>, signal: AbortSignal, call?: unknown, fetcher: typeof fetch = fetch) {
    const body = call === undefined ? undefined : validateCodexCall(call);
    let response: Response;
    try { response = await fetcher(`${config.origin}/v1/${body ? 'call' : 'status'}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]), body: body ? JSON.stringify(body) : undefined,
    }); } catch { throw new CodexGatewayError(signal.aborted ? 'cancelled' : 'unavailable', signal.aborted ? '工具调用已取消。' : 'Codex 网关连接失败或超时。', signal.aborted ? 499 : 503); }
    const result = await readCodexJson(response);
    if (!response.ok || result.ok !== true) {
        const codes = ['timeout', 'cancelled', 'busy', 'conflict', 'tool_denied', 'invalid_arguments', 'unsupported_version', 'tool_schema', 'tool_unavailable', 'too_large'];
        const code = typeof result.code === 'string' && codes.includes(result.code) ? result.code : 'executor_failed';
        const messages: Record<string, string> = { timeout: 'Codex 工具执行超时。', cancelled: '工具调用已取消。', busy: 'Codex 执行器繁忙。', conflict: '请求编号与原工具参数冲突。', unsupported_version: 'Codex 版本尚未适配。', tool_schema: '心潮只读工具格式不兼容。', tool_unavailable: '心潮工具暂不可用。', too_large: '工具结果超出容量，未截断正文。' };
        throw new CodexGatewayError(code, messages[code] ?? 'Codex 工具执行未成功，未使用其他执行器。', [400, 403, 409, 413, 429, 499, 503, 504].includes(response.status) ? response.status : 502);
    }
    if (result.protocol !== CODEX_GATEWAY_PROTOCOL || typeof result.version !== 'string' || !/^0\.(166|167)\.[A-Za-z0-9.+-]{1,40}$/.test(result.version)) throw new CodexGatewayError('protocol', 'Codex 网关握手不兼容。');
    if (body) {
        if (result.requestId !== body.requestId || result.tool !== body.tool || result.executor !== 'codex-mcp' || typeof result.text !== 'string' || new TextEncoder().encode(result.text).byteLength > 48 * 1024) throw new CodexGatewayError('protocol', 'Codex 工具回执不匹配。');
        return { protocol: CODEX_GATEWAY_PROTOCOL, requestId: body.requestId, tool: body.tool, text: result.text, executor: 'codex-mcp', version: result.version };
    }
    if (result.available !== true || !Array.isArray(result.tools) || result.tools.length !== CODEX_GATEWAY_TOOLS.length || !CODEX_GATEWAY_TOOLS.every(tool => (result.tools as unknown[]).includes(tool.name))) throw new CodexGatewayError('protocol', 'Codex 工具目录不兼容。');
    return { protocol: CODEX_GATEWAY_PROTOCOL, available: true, tools: CODEX_GATEWAY_TOOLS.map(tool => tool.name), version: result.version };
}
