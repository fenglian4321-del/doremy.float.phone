// No personal account/configuration or provider calls. Optional real CLI is explicit.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import * as policy from '../lib/codex-gateway-policy.mjs';
import { createGateway, readGatewayConfig } from '../tools/float-codex-gateway/server.mjs';

const require = createRequire(import.meta.url), token = 'synthetic-gateway-token-'.repeat(2), mcpToken = 'synthetic-mcp-token-'.repeat(2);
const configEnv = { FLOAT_XINCHAO_MCP_URL: 'http://127.0.0.1:18110/mcp', FLOAT_XINCHAO_MCP_TOKEN: mcpToken, FLOAT_CODEX_GATEWAY_TOKEN: token, FLOAT_CODEX_BIN: path.resolve('fixture-codex'), FLOAT_CODEX_STATE_DIR: path.resolve('fixture-state') };
assert.equal(readGatewayConfig(configEnv).port, 18220);
for (const address of ['file:///mcp', 'http://public.example/mcp', 'https://user:pass@example.com/mcp', 'https://example.com/mcp?token=secret']) assert.throws(() => readGatewayConfig({ ...configEnv, FLOAT_XINCHAO_MCP_URL: address }));
assert.throws(() => readGatewayConfig({ ...configEnv, FLOAT_CODEX_GATEWAY_TOKEN: mcpToken }));
for (const tool of ['command/exec', 'xinchao_event', 'breath', 'float_xinchao_context_extra']) assert.throws(() => policy.validateCodexTool(tool, {}));
for (const args of [{ url: 'https://example.com' }, { force: true }, { mode: 'session_start' }, { session_id: 'other' }, { max_tokens: 199 }, { max_tokens: 2401 }, { max_tokens: 200.1 }]) assert.throws(() => policy.validateCodexTool('float_xinchao_context', args));
assert.deepEqual(policy.validateCodexTool('float_xinchao_context', {}), { tool: 'xinchao_context', arguments: { mode: 'inspect', max_tokens: 1200 } });
assert.throws(() => policy.validateCodexTool('float_memory_pulse', { include_archive: true }));

const kv = new Map(), noop = () => undefined;
const sandbox = { console, fetch: globalThis.fetch, URL, URLSearchParams, Request, Response, Headers, Blob, ReadableStream, TextEncoder, TextDecoder, AbortSignal, AbortController, DOMException, Error, TypeError, setTimeout, clearTimeout, Date, Math, JSON, Promise, crypto: webcrypto, Event, window: { dispatchEvent: noop } };
function load(file, mocks = {}, extra = '') {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8') + '\n' + extra;
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { ...sandbox, module, exports: module.exports, process: { env: {} }, require: name => mocks[name] ?? (name.startsWith('node:') ? require(name) : new Proxy({}, { get: () => noop })) }, { filename: file });
    return module.exports;
}
const kvMock = { kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value), kvRemove: key => kv.delete(key), registerKvMigration: noop };
const ledger = load('../lib/usage-ledger.ts', { './kv-db': kvMock });
const proxy = load('../lib/server/codex-gateway.ts', { '../codex-gateway-policy.mjs': policy });
assert.equal(proxy.readCodexProxyConfig({}), null);
assert.throws(() => proxy.readCodexProxyConfig({ FLOAT_CODEX_GATEWAY_URL: 'http://127.0.0.1:18220', FLOAT_CODEX_GATEWAY_TOKEN: token }));
assert.throws(() => proxy.readCodexProxyConfig({ FLOAT_CODEX_GATEWAY_URL: 'https://example.com', FLOAT_CODEX_GATEWAY_TOKEN: token, FLOAT_SHARED_MEMORY_ACCESS_TOKEN: token }));
const body = { requestId: 'synthetic-request-0001', scopeId: 'a'.repeat(64), tool: 'float_xinchao_context', args: {} };
let proxyCalls = 0;
await assert.rejects(proxy.callCodexProxy({ origin: 'https://fixture.invalid', token }, new AbortController().signal, { ...body, url: 'https://other.invalid' }, async () => { proxyCalls++; }), /无效/);
assert.equal(proxyCalls, 0);
await assert.rejects(proxy.callCodexProxy({ origin: 'https://fixture.invalid', token }, new AbortController().signal, body, async () => Response.json({ ok: false, error: 'PRIVATE_TOOL_OUTPUT synthetic-secret' }, { status: 502 })), error => !error.message.includes('PRIVATE_TOOL_OUTPUT'));

const cli = process.env.FLOAT_TEST_CODEX_BIN;
if (!cli) {
    console.log('Codex gateway policy/proxy checks passed. Real CLI integration requires explicit FLOAT_TEST_CODEX_BIN; no user configuration is inspected.');
    process.exit(0);
}
const scratch = await mkdtemp(path.join(process.env.FLOAT_TEST_WORK_DIR || os.tmpdir(), 'float-codex-fixture-'));
let toolCalls = 0, delayed = false, errorResult = false, delayMs = 2000; const seenRpc = [], children = [];
const mcp = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${mcpToken}`);
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const reply = result => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'synthetic-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); } };
    if (message.method === 'initialize') return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-xinchao', version: '4.3-fixture' } });
    if (message.method === 'tools/list') return reply({ tools: [
        { name: 'xinchao_context', description: 'Synthetic context only', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['session_start', 'turn', 'inspect'] }, max_tokens: { type: 'integer', minimum: 200, maximum: 2400 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
        { name: 'pulse', description: 'Synthetic pulse only', inputSchema: { type: 'object', properties: { include_archive: { type: 'boolean' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
        { name: 'xinchao_event', description: 'Never exposed', inputSchema: { type: 'object' } },
    ] });
    if (message.method === 'tools/call') {
        toolCalls++;
        assert.ok(['xinchao_context', 'pulse'].includes(message.params.name));
        if (message.params.name === 'xinchao_context') assert.equal(message.params.arguments.mode, 'inspect');
        else assert.equal(message.params.arguments.include_archive, false);
        if (delayed) { const timer = setTimeout(() => reply({ content: [{ type: 'text', text: 'delayed synthetic result' }] }), delayMs); res.on('close', () => clearTimeout(timer)); return; }
        return reply({ content: [{ type: 'text', text: errorResult ? 'PRIVATE_TOOL_OUTPUT synthetic-secret' : 'synthetic xinchao state: calm' }], isError: errorResult });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Fixture method unavailable' } }));
});
await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
const gateway = await createGateway({ ...readGatewayConfig({ ...configEnv, FLOAT_XINCHAO_MCP_URL: `http://127.0.0.1:${mcp.address().port}/mcp`, FLOAT_CODEX_BIN: cli, FLOAT_CODEX_STATE_DIR: scratch }) }, { callTimeoutMs: 3000, spawnProcess: (...args) => {
    const child = spawn(...args); children.push(child);
    assert.equal(args[2].env.OPENAI_API_KEY, undefined); assert.equal(args[2].env.FLOAT_CODEX_GATEWAY_TOKEN, undefined);
    assert.ok(args[2].env.CODEX_HOME.startsWith(scratch));
    const write = child.stdin.write.bind(child.stdin); child.stdin.write = (chunk, ...rest) => { try { const rpc = JSON.parse(chunk); if (rpc.method) seenRpc.push(rpc.method); } catch {} return write(chunk, ...rest); };
    return child;
} });
await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${gateway.server.address().port}`;
const invoke = (value, options = {}) => fetch(origin + '/v1/call', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), ...options });
try {
    assert.equal((await fetch(origin + '/v1/status')).status, 401);
    assert.equal((await fetch(origin + '/v1/status', { headers: { Authorization: `Bearer ${token}`, Origin: 'http://float.fixture' } })).status, 403);
    const status = await fetch(origin + '/v1/status', { headers: { Authorization: `Bearer ${token}` } });
    const state = await status.json(); assert.equal(state.ok, true, JSON.stringify(state)); assert.equal(state.available, true);
    const [one, two] = await Promise.all([invoke(body), invoke(body)]);
    assert.equal(one.status, 200, JSON.stringify(await one.clone().json())); assert.deepEqual(await one.json(), await two.json()); assert.equal(toolCalls, 1, 'Concurrent retries share one tool invocation');
    assert.equal((await invoke({ ...body, args: { max_tokens: 2200 } })).status, 409);
    assert.equal((await invoke({ ...body, tool: 'command/exec' })).status, 403);
    assert.equal((await invoke({ ...body, args: { mode: 'session_start' } })).status, 400);
    assert.equal(toolCalls, 1, 'Denied tools/arguments never reach MCP');
    errorResult = true;
    const failure = await invoke({ ...body, requestId: 'synthetic-error-0001' }); assert.equal(failure.status, 502); assert.ok(!(await failure.text()).includes('PRIVATE_TOOL_OUTPUT'));
    errorResult = false;
    const ownerApi = load('../lib/server/shared-memory.ts');
    const owner = { baseUrl: 'https://ombre.fixture', password: 'synthetic-password', accessToken: 'synthetic-owner-token-'.repeat(2) };
    const proxyConfig = { origin, token };
    const route = load('../app/api/shared-memory/codex/route.ts', {
        'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
        '@/lib/codex-gateway-policy.mjs': policy,
        '@/lib/server/shared-memory': { ...ownerApi, readSharedMemoryConfig: () => owner },
        '@/lib/server/codex-gateway': { ...proxy, readCodexProxyConfig: () => proxyConfig },
    });
    const cookie = ownerApi.sharedMemorySessionCookie(new Request('http://float.fixture/api/shared-memory'), owner).split(';')[0];
    assert.equal((await route.GET(new Request('http://float.fixture/api/shared-memory/codex'))).status, 401);
    assert.equal((await route.POST(new Request('http://float.fixture/api/shared-memory/codex', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://other.fixture' }, body: JSON.stringify(body) }))).status, 403);
    const publicRoute = load('../app/api/shared-memory/codex/route.ts', {
        'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
        '@/lib/codex-gateway-policy.mjs': policy,
        '@/lib/server/shared-memory': { ...ownerApi, readSharedMemoryConfig: () => owner,
            sharedMemoryRequestOrigin: request => ownerApi.sharedMemoryRequestOrigin(request, { FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN: 'https://float.fixture' }) },
        '@/lib/server/codex-gateway': { ...proxy, readCodexProxyConfig: () => proxyConfig },
    });
    const behindProxy = origin => new Request('http://0.0.0.0:3001/api/shared-memory/codex', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Forwarded-Host': 'float.fixture', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify(body) });
    assert.equal((await publicRoute.POST(behindProxy('https://float.fixture'))).status, 200, 'Configured public origin works behind standalone proxy');
    assert.equal((await publicRoute.POST(behindProxy('https://other.fixture'))).status, 403, 'Spoofed forwarded headers do not authorize another origin');
    const nativeFetch = globalThis.fetch;
    let modelAttempts = 0, modelToolName, streaming = false;
    const sse = events => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    sandbox.fetch = async (url, init = {}) => {
        if (url === '/api/shared-memory/codex') return route[init.method || 'GET'](new Request('http://float.fixture' + url, { ...init, headers: { ...init.headers, Cookie: cookie, Origin: 'http://float.fixture' } }));
        if (url === 'https://model.fixture/v1/chat/completions') {
            modelAttempts++; const request = JSON.parse(init.body);
            assert.equal(init.headers.Authorization, 'Bearer synthetic-model-key'); assert.equal(request.model, 'selected-fixture-model');
            if (modelAttempts === 1) { modelToolName = request.tools.find(t => t.function.description.includes('float_xinchao_context')).function.name;
                if (streaming) return sse([
                    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture_call_1', function: { name: modelToolName, arguments: '{"max_tokens":' } }] } }] },
                    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '800}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }, '[DONE]',
                ]);
                return Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'fixture_call_1', type: 'function', function: { name: modelToolName, arguments: '{"max_tokens":800}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }); }
            const result = request.messages.find(message => message.role === 'tool'); assert.equal(result.tool_call_id, 'fixture_call_1'); assert.ok(result.content.includes('synthetic xinchao state: calm'), result.content);
            assert.ok(request.messages.some(message => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'fixture_call_1'));
            if (streaming) return sse([{ choices: [{ delta: { content: '我读到了合成的心潮状态。' } }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } }, '[DONE]']);
            return Response.json({ choices: [{ message: { content: '我读到了合成的心潮状态。' } }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } });
        }
        throw Error('Unexpected egress: ' + url);
    };
    const client = load('../lib/codex-gateway-client.ts', { './kv-db': kvMock, './memory-storage': { loadMemoryConfig: () => ({ memorySource: 'shared' }) }, './usage-ledger': ledger, './codex-gateway-policy.mjs': policy, './abort-utils': load('../lib/abort-utils.ts') });
    client.setCodexGatewayEnabled(true);
    const transport = load('../lib/usage-fetch.ts', { './usage-ledger': ledger, './token-usage': load('../lib/token-usage.ts') });
    const http = load('../lib/llm-http.ts', { './usage-fetch': transport });
    const helpers = load('../lib/api-helpers.ts', { './token-usage': load('../lib/token-usage.ts'), './usage-fetch': transport });
    const protocol = load('../lib/consolidation-protocol.ts', { './token-counter': load('../lib/token-counter.ts') });
    const adapter = load('../lib/llm-provider-adapter.ts', { './api-helpers': helpers, './token-usage': load('../lib/token-usage.ts'), './generation-parameters': { resolveEnabledGenerationParameters: () => new Set() } });
    assert.equal(client.getCodexGatewayTools('chat').length, 0);
    assert.equal(client.getCodexGatewayTools('group_chat').length, 0);
    await assert.rejects(client.executeCodexGatewayTool('float_xinchao_context', {}, { sessionId: 'probe', appId: 'chat', sourceEngine: 'chat' }), /显式诊断/);
    // Exercise the retained prototype through an explicit diagnostic adapter.
    const diagnosticClient = { ...client, executeCodexGatewayTool: (name, args, context) => client.executeCodexGatewayTool(name, args, { ...context, appId: 'diagnostic', sourceEngine: 'diagnostic' }) };
    const toolExecutor = load('../lib/tool-executor.ts', { './codex-gateway-client': diagnosticClient, './abort-utils': load('../lib/abort-utils.ts'), './life/life-storage': { loadVirtualLifeState: () => ({ settings: { enabled: false } }) } });
    class Macro { expand(text) { return text; } }
    const engine = load('../lib/chat-engine.ts', {
        './consolidation-protocol': protocol,
        './llm-provider-adapter': adapter, './llm-http': http, './tool-executor': toolExecutor,
        './tool-storage': { getEnabledTools: () => policy.CODEX_GATEWAY_TOOLS.map(tool => ({ ...tool, parameterSchema: JSON.stringify(tool.parameters), source: 'codex_gateway', sourceId: tool.name })) },
        './chat-storage': { loadChatSessions: () => [], isSessionStreamingEnabled: () => streaming, getMaxToolRounds: () => 5, createToolExecutionId: () => webcrypto.randomUUID() },
        './sse-json': load('../lib/sse-json.ts'),
        './settings-storage': { getMaxToolRounds: () => 5 }, './kv-db': kvMock,
        './macro-engine': { MacroEngine: Macro, postProcessTrim: text => text },
        './chat-plugin-hooks': { runChatPluginTransform: async (_event, payload) => payload, emitChatPluginEvent: noop },
        './llm-prompt-assembler': { applyOutputRegex: text => text },
        './chat-avatar-intent': { applyWithProtectedAvatarDecisionMarkers: (text, transform) => transform(text) },
        './content-tag-utils': { mergeAppTags: () => [], getActiveAppTags: () => [] },
        './prompt-sanitizer': { stripStateAndInnerForPrompt: text => text },
        './action-parser': { parseActionTags: text => ({ cleanText: text, actions: [] }) },
    }, 'export { generateNativeChatCompletion };');
    const result = await engine.generateNativeChatCompletion({ session: { id: 'synthetic-app-session' }, llmMessages: [{ role: 'user', content: '读取心潮状态' }], character: { id: 'fixture-character', name: '合成角色' }, config: { id: 'fixture-config', provider: 'Custom', baseUrl: 'https://model.fixture/v1', apiKey: 'synthetic-model-key', defaultModel: 'selected-fixture-model' }, preset: null, regexes: [], options: { appId: 'chat' }, bailoutRef: { shortcutHandles: [] } });
    assert.equal(result.parts.at(-1).text, '我读到了合成的心潮状态。'); assert.equal(modelAttempts, 2);
    const rows = ledger.getUsageLedger(); assert.equal(rows.filter(row => row.source === 'tool' && row.status === 'completed').length, 1);
    assert.equal(rows.filter(row => row.source === 'chat' && row.status === 'completed').length, 2);
    assert.ok(!JSON.stringify(rows).includes('synthetic-model-key')); assert.ok(!JSON.stringify(rows).includes('synthetic xinchao state'));
    streaming = true; modelAttempts = 0;
    const streamed = await engine.generateNativeChatCompletion({ session: { id: 'synthetic-stream-session' }, llmMessages: [{ role: 'user', content: '读取心潮状态' }], character: { id: 'fixture-character', name: '合成角色' }, config: { id: 'fixture-config', provider: 'Custom', baseUrl: 'https://model.fixture/v1', apiKey: 'synthetic-model-key', defaultModel: 'selected-fixture-model' }, preset: null, regexes: [], options: { appId: 'chat' }, bailoutRef: { shortcutHandles: [] } });
    assert.equal(streamed.parts.at(-1).text, '我读到了合成的心潮状态。'); assert.equal(modelAttempts, 2);
    assert.equal(ledger.getUsageLedger().filter(row => row.source === 'tool' && row.status === 'completed').length, 2);
    assert.equal(ledger.summarizeUsage(ledger.getUsageLedger()).unknown, 0, 'Tool receipts are not missing model usage');
    delayed = true; delayMs = 5000;
    const timedOut = await invoke({ ...body, requestId: 'synthetic-timeout-0001' }); assert.equal(timedOut.status, 504); assert.equal((await timedOut.json()).code, 'timeout');
    delayed = false;
    const afterTimeout = await invoke({ ...body, requestId: 'synthetic-after-timeout' }); assert.equal(afterTimeout.status, 200, await afterTimeout.text());
    delayed = true;
    const abort = new AbortController(); const cancelled = invoke({ ...body, requestId: 'synthetic-cancel-0001' }, { signal: abort.signal });
    const before = toolCalls; while (toolCalls === before) await new Promise(resolve => setTimeout(resolve, 20));
    abort.abort(); await assert.rejects(cancelled); delayed = false;
    const afterCancel = await invoke({ ...body, requestId: 'synthetic-after-cancel' }); assert.equal(afterCancel.status, 200, await afterCancel.text());
    assert.ok(seenRpc.includes('mcpServer/tool/call')); assert.ok(seenRpc.every(method => ['initialize', 'initialized', 'thread/start', 'mcpServerStatus/list', 'mcpServer/tool/call'].includes(method)));
    globalThis.fetch = nativeFetch;
    console.log('Explicit diagnostic adapter: real Codex + synthetic HTTP MCP + real owner proxy/client/executor/native model loop: JSON and SSE tool arguments/return-to-same-model, model usage and separate tool receipts, no Codex inference RPC, isolated home, allowlist/auth/redaction/idempotency/conflict/timeout/cancel recovery passed. No private API or VPS accessed.');
} finally {
    await gateway.close(); const stopped = new Promise(resolve => mcp.close(resolve)); mcp.closeAllConnections(); await stopped;
    for (const child of children) child.kill();
}
