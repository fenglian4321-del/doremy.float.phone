import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { randomUUID } from 'node:crypto';
import { ManagedMcpError, mcpObject } from '../managed-mcp-policy';

export const MCP_WIRE_VERSION = '2025-06-18';
export type ManagedMcpTransportDeps = { lookup: typeof lookup; request: typeof httpsRequest };
export function publicMcpAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
    }
    if (family === 6) { const value = new URL('https://[' + address + ']/').hostname.slice(1, -1).toLowerCase(); const parts = value.split(':'); return /^[23][0-9a-f]{3}:/.test(value) && !(parts[0] === '2001' && (parseInt(parts[1] || '0', 16) < 0x200 || parts[1] === 'db8')) && !value.startsWith('2002:') && !value.startsWith('3fff:'); }
    return false;
}
export function managedMcpUrl(raw: unknown): URL {
    if (typeof raw !== 'string' || raw.length > 2048) throw new ManagedMcpError('configuration');
    let url: URL; try { url = new URL(raw); } catch { throw new ManagedMcpError('configuration'); }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !host || (isIP(host) ? !publicMcpAddress(host) : !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host))) throw new ManagedMcpError('configuration', '首版仅允许管理员固定的公网HTTPS MCP地址。', 503);
    return url;
}
/** No generic fetch/proxy, redirect, retry, OAuth, subprocess or server requests. */
export function createManagedMcpTransport(url: URL, token: string, origin: string, deps: ManagedMcpTransportDeps = { lookup, request: httpsRequest }) {
    let session = '';
    async function rpc(method: string, params: Record<string, unknown>, signal: AbortSignal, notification = false): Promise<Record<string, unknown>> {
        signal.throwIfAborted();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const pending = deps.lookup(hostname, { all: true, verbatim: true });
        const resolved = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
            const abort = () => reject(new ManagedMcpError('cancelled', 'MCP连接已停止。', 499));
            signal.addEventListener('abort', abort, { once: true });
            void pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, () => { signal.removeEventListener('abort', abort); reject(new ManagedMcpError('connection', 'MCP地址解析失败。', 503)); });
            if (signal.aborted) abort();
        });
        signal.throwIfAborted();
        if (!resolved.length || resolved.length > 16 || resolved.some(value => !publicMcpAddress(value.address))) throw new ManagedMcpError('address_denied', '服务地址解析到未允许的网络范围。', 403);
        const selected = resolved[0], id = randomUUID();
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params }));
        return new Promise((resolve, reject) => {
            let settled = false, bytes = 0, raw = '', carry = '', notifications = 0;
            const decoder = new TextDecoder('utf-8', { fatal: true });
            const finish = (value?: Record<string, unknown>, error?: ManagedMcpError) => { if (settled) return; settled = true; if (error) reject(error); else resolve(value || {}); req.destroy(); };
            const parse = (text: string) => {
                let value: unknown; try { value = JSON.parse(text); } catch { throw new ManagedMcpError('protocol', 'MCP返回了无效JSON。', 502); }
                if (!mcpObject(value) || value.jsonrpc !== '2.0') throw new ManagedMcpError('protocol');
                if (token && JSON.stringify(value).includes(token)) throw new ManagedMcpError('secret_result');
                if (value.method !== undefined) { if (value.id !== undefined || ++notifications > 32) throw new ManagedMcpError('server_request', '未授权MCP服务端请求。', 403); return; }
                if (value.id !== id || (value.result === undefined) === (value.error === undefined)) throw new ManagedMcpError('receipt', 'MCP原调用编号或结果格式不匹配。', 502);
                if (value.error !== undefined) throw new ManagedMcpError('remote_error', 'MCP返回工具协议错误；未转发远端错误正文。', 502);
                if (!mcpObject(value.result)) throw new ManagedMcpError('protocol');
                finish(value.result);
            };
            const options: RequestOptions = { method: 'POST', agent: false, servername: hostname, rejectUnauthorized: true, signal,
                lookup: ((_name: unknown, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => opts.all ? callback(null, [selected]) : callback(null, selected.address, selected.family)) as RequestOptions['lookup'],
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': String(body.length), Origin: origin, 'MCP-Protocol-Version': MCP_WIRE_VERSION, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(session ? { 'Mcp-Session-Id': session } : {}) } };
            const req = deps.request(url, options, res => {
                const status = res.statusCode || 0, contentType = res.headers['content-type'] || '';
                if (notification) { if (status === 202) finish({}); else finish(undefined, new ManagedMcpError('notification', 'MCP未确认初始化通知。', 502)); return; }
                if (status !== 200 || (!contentType.includes('application/json') && !contentType.includes('text/event-stream'))) { finish(undefined, new ManagedMcpError(status >= 300 && status < 400 ? 'redirect_denied' : 'http_error', 'MCP响应状态或类型不受支持；未重定向或重试。', 502)); return; }
                const nextSession = res.headers['mcp-session-id'];
                if (nextSession !== undefined) { if (typeof nextSession !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(nextSession) || (session && session !== nextSession)) { finish(undefined, new ManagedMcpError('session')); return; } session = nextSession; }
                res.on('data', (chunk: Buffer) => {
                    if (settled) return;
                    try {
                        bytes += chunk.length; if (bytes > 65536) throw new ManagedMcpError('capacity', 'MCP响应超过64KiB，未截断。', 413);
                        const decoded = decoder.decode(chunk, { stream: true }); raw += decoded;
                        if (token && raw.includes(token)) throw new ManagedMcpError('secret_result', 'MCP响应含服务凭据，未返回正文。', 502);
                        if (contentType.includes('text/event-stream')) {
                            carry += decoded;
                            let boundary: RegExpExecArray | null;
                            while (!settled && (boundary = /\r?\n\r?\n/.exec(carry))) {
                                const event = carry.slice(0, boundary.index); carry = carry.slice(boundary.index + boundary[0].length);
                                const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
                                if (payload) parse(payload);
                            }
                        }
                    } catch (error) { finish(undefined, error instanceof ManagedMcpError ? error : new ManagedMcpError('protocol')); }
                });
                res.on('end', () => { if (settled) return; try { raw += decoder.decode(); if (token && raw.includes(token)) throw new ManagedMcpError('secret_result'); if (contentType.includes('application/json')) parse(raw); if (!settled) throw new ManagedMcpError('protocol'); } catch (error) { finish(undefined, error instanceof ManagedMcpError ? error : new ManagedMcpError('protocol')); } });
                res.on('error', () => finish(undefined, new ManagedMcpError('connection', 'MCP响应中断，未自动重试。', 503)));
            });
            req.on('error', () => finish(undefined, new ManagedMcpError(signal.aborted ? 'cancelled' : 'connection', 'MCP连接未完成；不会重试原工具调用。', signal.aborted ? 499 : 503)));
            req.end(body);
        });
    }
    return { rpc, async initialize(signal: AbortSignal) {
        const result = await rpc('initialize', { protocolVersion: MCP_WIRE_VERSION, capabilities: {}, clientInfo: { name: 'float-managed', version: '1' } }, signal);
        if (result.protocolVersion !== MCP_WIRE_VERSION || !mcpObject(result.capabilities) || !mcpObject(result.capabilities.tools)) throw new ManagedMcpError('version', '服务未匹配首版协议/工具能力。', 502);
        // Server instructions, prompts, roots, resources and sampling are never consumed.
        await rpc('notifications/initialized', {}, signal, true);
    } };
}
