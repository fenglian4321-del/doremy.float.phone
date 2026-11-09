import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CODEX_GATEWAY_PROTOCOL, CODEX_GATEWAY_TOOLS, CodexGatewayError, isObject, validateCodexCall, validateCodexTool } from '../../lib/codex-gateway-policy.mjs';

const fail = (code = 'protocol', message = 'Codex 执行协议不兼容，未改用其他执行器。', status = 502) => new CodexGatewayError(code, message, status);
const hash = value => createHash('sha256').update(value).digest();
const checkAbort = signal => { if (signal?.aborted) throw signal.reason instanceof CodexGatewayError ? signal.reason : fail('cancelled', '工具调用已取消。', 499); };
export function readGatewayConfig(env = process.env) {
    const token = env.FLOAT_CODEX_GATEWAY_TOKEN, mcpToken = env.FLOAT_XINCHAO_MCP_TOKEN;
    let endpoint; try { endpoint = new URL(env.FLOAT_XINCHAO_MCP_URL); } catch { throw fail('configuration', '请配置心潮 MCP 地址。', 503); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp'
        || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))
        || typeof token !== 'string' || token.length < 32 || token.length > 512
        || typeof mcpToken !== 'string' || mcpToken.length < 32 || mcpToken.length > 512 || token === mcpToken) throw fail('configuration', '网关地址或独立凭据配置无效。', 503);
    const stateDir = env.FLOAT_CODEX_STATE_DIR, executable = env.FLOAT_CODEX_BIN;
    if (!stateDir || !path.isAbsolute(stateDir) || !executable || !path.isAbsolute(executable)) throw fail('configuration', '请配置绝对路径的 Codex 程序与专用状态目录。', 503);
    const port = Number(env.FLOAT_CODEX_GATEWAY_PORT || 18220);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fail('configuration', '网关监听端口无效。', 503);
    return { token, mcpToken, endpoint: endpoint.href, stateDir, executable, port };
}

// This class never starts an inference turn. Its home is created by the gateway,
// and never points at the operator's official Codex login/configuration.
class Worker {
    constructor(config, spawnProcess) { this.config = config; this.spawnProcess = spawnProcess; this.pending = new Map(); this.seq = 0; this.dead = false; this.lastUsed = Date.now(); }
    async start(signal) {
        checkAbort(signal);
        const home = await mkdtemp(path.join(this.config.stateDir, 'executor-'));
        await writeFile(path.join(home, 'config.toml'), [
            "model='float-executor-no-inference'", "model_provider='float_executor_only'", 'project_root_markers=[]',
            '[model_providers.float_executor_only]', "name='Execution only - no inference'", "base_url='http://127.0.0.1:9/v1'", "wire_api='responses'", 'requires_openai_auth=false', 'supports_websockets=false',
            '[mcp_servers.xinchao]', `url=${JSON.stringify(this.config.endpoint)}`, "bearer_token_env_var='FLOAT_XINCHAO_MCP_TOKEN'", 'required=true', 'enabled_tools=["xinchao_context","pulse"]',
        ].join('\n') + '\n', { mode: 0o600, flag: 'wx' });
        checkAbort(signal);
        const env = {};
        for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
        Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, FLOAT_XINCHAO_MCP_TOKEN: this.config.mcpToken });
        this.child = this.spawnProcess(this.config.executable, ['app-server', '--listen', 'stdio://'], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
        this.child.on('error', () => this.close(fail('unavailable', 'Codex 执行进程未能启动。', 503)));
        this.child.on('exit', () => this.close(fail('unavailable', 'Codex 执行进程已结束，请重新读取。', 503)));
        this.child.stdin.on('error', () => this.close(fail('unavailable', 'Codex 执行连接已中断。', 503)));
        this.child.stderr.on('data', () => {}); // Never log MCP payloads, paths, tokens or upstream errors.
        let buffered = '';
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', chunk => {
            buffered += chunk;
            let end;
            while ((end = buffered.indexOf('\n')) >= 0) {
                const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
                if (Buffer.byteLength(line) > 256 * 1024) { this.close(fail('too_large', 'Codex 工具响应超出容量，未截断正文。', 413)); return; }
                let value; try { value = JSON.parse(line); } catch { this.close(fail()); return; }
                if (!isObject(value)) { this.close(fail()); return; }
                const pending = this.pending.get(value.id);
                if (pending) { this.pending.delete(value.id); value.error ? pending.reject(fail()) : pending.resolve(value.result); }
                else if (value.id !== undefined) this.child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32000, message: 'No interactive or additional permissions granted by Float executor' } }) + '\n');
            }
            if (Buffer.byteLength(buffered) > 256 * 1024) this.close(fail('too_large', 'Codex 工具响应超出容量。', 413));
        });
        const initialized = await this.rpc('initialize', { clientInfo: { name: 'float_private_executor', title: 'Float fixed read-only MCP executor', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }, signal);
        if (!isObject(initialized) || typeof initialized.userAgent !== 'string') throw fail();
        const version = /float_private_executor\/(0\.(?:166|167)\.[A-Za-z0-9.+-]+)/.exec(initialized.userAgent)?.[1];
        if (!version) throw fail('unsupported_version', '当前 Codex 版本不在已核对的 0.166/0.167 协议范围。', 503);
        this.version = version;
        this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        const started = await this.rpc('thread/start', { model: 'float-executor-no-inference', modelProvider: 'float_executor_only', cwd: home, ephemeral: true, approvalPolicy: 'on-request', sandbox: 'read-only' }, signal);
        if (!isObject(started?.thread) || typeof started.thread.id !== 'string') throw fail();
        this.threadId = started.thread.id;
        const inventory = await this.rpc('mcpServerStatus/list', { threadId: this.threadId, serverName: 'xinchao', detail: 'toolsAndAuthOnly' }, signal);
        const server = inventory?.data?.find(item => item.name === 'xinchao');
        if (!server || server.toolsError || !isObject(server.tools)) throw fail('tool_unavailable', '心潮工具目录未能验证。', 503);
        const tools = Object.values(server.tools);
        const context = tools.find(tool => tool.name === 'xinchao_context'), pulse = tools.find(tool => tool.name === 'pulse');
        if (!context || !pulse || context.annotations?.readOnlyHint !== true || pulse.annotations?.readOnlyHint === false
            || !context.inputSchema?.properties?.mode?.enum?.includes('inspect')
            || context.inputSchema?.properties?.max_tokens?.type !== 'integer'
            || pulse.inputSchema?.properties?.include_archive?.type !== 'boolean') throw fail('tool_schema', '心潮只读工具格式与已核对版本不一致。', 503);
        this.ready = true;
    }
    rpc(method, params, signal) {
        checkAbort(signal);
        if (this.dead) return Promise.reject(fail('unavailable', '执行连接已中断。', 503));
        return new Promise((resolve, reject) => {
            const id = ++this.seq;
            const abort = () => this.close(signal.reason instanceof CodexGatewayError ? signal.reason : fail('cancelled', '工具调用已取消。', 499));
            const finish = callback => value => { signal?.removeEventListener('abort', abort); callback(value); };
            this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) { abort(); return; }
            this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
    }
    close(error = fail('unavailable', '执行连接已关闭。', 503)) {
        if (this.dead) return; this.dead = true;
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        if (this.child) {
            this.child.stdin.end();
            const pid = this.child.pid;
            // Only the dedicated child tree is stopped; never terminate by image name.
            if (pid && process.platform === 'win32') {
                const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                killer.on('error', () => this.child.kill()); killer.unref();
            } else if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch { this.child.kill(); } }
            this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.stdin.destroy(); this.child.unref();
        }
    }
    async call(body, signal) {
        const invocation = validateCodexTool(body.tool, body.args);
        const result = await this.rpc('mcpServer/tool/call', { threadId: this.threadId, server: 'xinchao', ...invocation }, signal);
        if (result?.isError) throw fail('tool_error', '心潮只读工具返回失败，请核对服务后重试。');
        if (!Array.isArray(result?.content) || result.content.some(item => item.type !== 'text' || typeof item.text !== 'string')) throw fail();
        const text = result.content.map(item => item.text).join('\n');
        if (Buffer.byteLength(text) > 48 * 1024) throw fail('too_large', '工具结果超出容量，未截断正文；请缩小上下文长度。', 413);
        return { protocol: CODEX_GATEWAY_PROTOCOL, requestId: body.requestId, tool: body.tool, text, executor: 'codex-mcp', version: this.version };
    }
}

export async function createGateway(config, { spawnProcess = spawn, callTimeoutMs = 35_000 } = {}) {
    if (!Number.isInteger(callTimeoutMs) || callTimeoutMs < 100 || callTimeoutMs > 35_000) throw fail('configuration', '执行器超时配置无效。', 503);
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const scopes = new Map(), receipts = new Map(), requests = new Set();
    let closing = false;
    function scope(id) {
        if (!scopes.has(id)) {
            if (scopes.size >= 8) {
                const idle = [...scopes].filter(([, s]) => s.waiters === 0).sort((a, b) => a[1].at - b[1].at)[0];
                if (!idle) throw fail('busy', '执行器并发已满，请稍后重试。', 429);
                idle[1].worker?.close(); scopes.delete(idle[0]);
            }
            scopes.set(id, { tail: Promise.resolve(), waiters: 0, at: Date.now(), worker: null });
        }
        return scopes.get(id);
    }
    async function run(id, signal, body) {
        const state = scope(id);
        if (state.waiters >= 4) throw fail('busy', '当前会话的工具队列已满。', 429);
        state.waiters++;
        const queued = state.tail.catch(() => {}).then(async () => {
            checkAbort(signal);
            if (closing) throw fail('unavailable', '执行器正在停止。', 503);
            if (!state.worker || state.worker.dead) state.worker = new Worker(config, spawnProcess);
            try {
                if (!state.worker.ready) await state.worker.start(signal);
                return body ? await state.worker.call(body, signal) : { protocol: CODEX_GATEWAY_PROTOCOL, available: true, version: state.worker.version, tools: CODEX_GATEWAY_TOOLS.map(tool => tool.name) };
            } catch (error) { state.worker.close(); throw error; }
        });
        state.tail = queued;
        try { return await queued; } finally { state.waiters--; state.at = Date.now(); }
    }
    function clean() {
        const now = Date.now();
        for (const [key, value] of receipts) if (value.done && now - value.at > 10 * 60_000) receipts.delete(key);
        for (const [key, value] of scopes) if (!value.waiters && now - value.at > 5 * 60_000) { value.worker?.close(); scopes.delete(key); }
    }
    const interval = setInterval(clean, 30_000); interval.unref();
    async function read(req) {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 8192) throw fail('too_large', '工具请求超过容量。', 413); chunks.push(chunk); }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('invalid_request', '工具请求不是有效 JSON。', 400); }
    }
    function subscribe(receipt, signal) {
        receipt.users++;
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (callback, value) => {
                if (finished) return; finished = true; signal.removeEventListener('abort', abort); receipt.users--;
                if (!receipt.done && receipt.users === 0) receipt.controller.abort();
                callback(value);
            };
            const abort = () => finish(reject, fail('cancelled', '工具调用已取消。', 499));
            signal.addEventListener('abort', abort, { once: true });
            receipt.promise.then(value => finish(resolve, value), error => finish(reject, error));
            if (signal.aborted) abort();
        });
    }
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('X-Content-Type-Options', 'nosniff');
        const controller = new AbortController(); requests.add(controller); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
            if (closing) throw fail('unavailable', '执行器正在停止。', 503);
            const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
            if (!token || token.length > 512 || !timingSafeEqual(hash(token), hash(config.token))) throw fail('unauthorized', '执行器服务凭据无效。', 401);
            if (req.headers.origin || req.headers['sec-fetch-site']) throw fail('forbidden', '执行器仅接受服务端代理请求。', 403);
            let result;
            if (req.method === 'GET' && req.url === '/v1/status') {
                const timer = setTimeout(() => controller.abort(fail('timeout', '执行器连接检查超时。', 504)), 35_000);
                try { result = await run('status', controller.signal); } finally { clearTimeout(timer); }
            } else if (req.method === 'POST' && req.url === '/v1/call') {
                const body = validateCodexCall(await read(req));
                const key = `${body.scopeId}:${body.requestId}`;
                const invocation = validateCodexTool(body.tool, body.args);
                const fingerprint = hash(JSON.stringify(invocation)).toString('hex');
                clean(); let receipt = receipts.get(key);
                if (receipt && receipt.fingerprint !== fingerprint) throw fail('conflict', '同一请求编号不能执行不同参数。', 409);
                if (!receipt) {
                    if (receipts.size >= 1000) {
                        const completed = [...receipts].find(([, item]) => item.done); if (completed) receipts.delete(completed[0]);
                        else throw fail('busy', '执行器回执队列已满。', 429);
                    }
                    const active = new AbortController();
                    receipt = { fingerprint, controller: active, users: 0, done: false, at: Date.now() };
                    const timer = setTimeout(() => active.abort(fail('timeout', 'Codex 工具调用超时，请核对服务。', 504)), callTimeoutMs);
                    receipt.promise = run(body.scopeId, active.signal, body).finally(() => { clearTimeout(timer); receipt.done = true; receipt.at = Date.now(); if (active.signal.aborted) receipts.delete(key); });
                    receipts.set(key, receipt);
                }
                result = await subscribe(receipt, controller.signal);
            } else throw fail('not_found', '未开放此执行器接口。', 404);
            if (!res.destroyed) res.end(JSON.stringify({ ok: true, ...result }));
        } catch (error) {
            if (!res.destroyed) { const known = error instanceof CodexGatewayError; res.statusCode = known ? error.status : 502; res.end(JSON.stringify({ ok: false, code: known ? error.code : 'protocol', error: known ? error.message : '执行器调用失败。' })); }
        } finally { requests.delete(controller); }
    });
    server.requestTimeout = 45_000; server.headersTimeout = 10_000;
    return { server, async close() {
        closing = true; clearInterval(interval);
        for (const controller of requests) controller.abort();
        for (const receipt of receipts.values()) receipt.controller.abort();
        for (const state of scopes.values()) state.worker?.close(); scopes.clear();
        const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped;
    } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const config = readGatewayConfig(); const gateway = await createGateway(config);
    gateway.server.listen(config.port, '127.0.0.1', () => console.log('Float fixed read-only Codex gateway listening on loopback.'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { gateway.close().finally(() => process.exit(0)); });
}
