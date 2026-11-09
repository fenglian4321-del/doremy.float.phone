// Synthetic data only. No Codex process, real provider, account, chat or vault.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url), noop = () => {}, kv = new Map(), notices = [];
let fetcher = async () => { throw Error('Unexpected network'); };
function load(file, mocks = {}) {
    const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, require: name => mocks[name] ?? (name.startsWith('node:') ? require(name) : new Proxy({}, { get: () => noop })),
        fetch: (...args) => fetcher(...args), console, process: { env: {} }, URL, URLSearchParams, Request, Response, Headers, Blob, ReadableStream,
        TextEncoder, TextDecoder, AbortSignal, AbortController, DOMException, Error, TypeError, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, crypto: webcrypto, CustomEvent,
        window: { dispatchEvent: event => notices.push(event.detail) } }, { filename: file });
    return module.exports;
}
const counter = load('../lib/token-counter.ts');
const protocol = load('../lib/consolidation-protocol.ts', { './token-counter': counter });
const budget = load('../lib/consolidation-budget.ts', { './token-counter': counter });
const scope = { kind: 'chat', sessionId: 'synthetic-chat', actorId: 'role-a' };
const persisted = [{ id: 'sent-user', sessionId: scope.sessionId, role: 'user', content: '我周二去看画展。', status: 'sent', createdAt: '2026-11-09T12:00:00Z' },
    { id: 'reply-a', sessionId: scope.sessionId, role: 'assistant', content: '我记得了。', status: 'sent', createdAt: '2026-11-09T12:00:01Z' },
    { id: 'reply-b', sessionId: scope.sessionId, role: 'assistant', content: '到时候聊聊。', status: 'sent', createdAt: '2026-11-09T12:00:02Z' },
    { id: 'not-sent', sessionId: scope.sessionId, role: 'user', content: 'PRIVATE_UNSENT', status: 'sending', createdAt: '2026-11-09T12:00:03Z' },
    { id: 'fiction', sessionId: scope.sessionId, role: 'user', origin: 'story', content: 'PRIVATE_STORY', status: 'sent', createdAt: '2026-11-09T12:00:04Z' }];
const records = await protocol.collectConsolidationRecords(scope, persisted);
assert.equal(records.length, 2); assert.equal(records[1].parts.length, 2);
const regenerated = await protocol.collectConsolidationRecords(scope, [persisted[0], { ...persisted[1], id: 'new-reply-id', content: '重新生成' }]);
assert.equal(regenerated[1].id, records[1].id); assert.notEqual(regenerated[1].digest, records[1].digest);
assert.notEqual(await protocol.consolidationScopeId(scope), await protocol.consolidationScopeId({ ...scope, actorId: 'role-b' }));
const hidden = `${protocol.DECISION_OPEN}{"private":true}${protocol.DECISION_CLOSE}`;
for (let split = 0; split <= hidden.length; split++) {
    const filter = protocol.createPrivateDecisionStreamFilter();
    assert.equal(filter.push('正常回复' + hidden.slice(0, split)) + filter.push(hidden.slice(split) + '后文') + filter.flush(), '正常回复');
}
assert.equal(protocol.extractPrivateDecision('可见' + protocol.DECISION_OPEN + 'broken').text, '可见');
assert.ok(protocol.extractPrivateDecision(hidden + hidden).envelope.error);
const nested = protocol.DECISION_OPEN + JSON.stringify({ quote: protocol.DECISION_CLOSE, nested: protocol.DECISION_OPEN }) + protocol.DECISION_CLOSE;
assert.ok(protocol.extractPrivateDecision('可见' + nested).envelope.raw);
const nestedFilter = protocol.createPrivateDecisionStreamFilter();
assert.equal(Array.from('可见' + nested).map(char => nestedFilter.push(char)).join(''), '可见');
const base = { protocol: 'float-consolidation/v1', config: { ...protocol.DEFAULT_CONSOLIDATION_CONFIG, count: 1 }, version: 1, count: 1, tokens: 30, pending: 2, dirty: 0, due: true, queued: false, lastSuccess: null, summary: [], active: null };
const kvMock = { registerDynamicPrefix: noop, kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value) };
let paused = false, manualOnly = false;
const client = load('../lib/consolidation-client.ts', { './kv-db': kvMock, './token-counter': counter, './consolidation-protocol': protocol,
    './memory-storage': { loadMemoryConfig: () => ({ memorySource: 'shared', automaticWritesPaused: paused }) }, './chat-storage': { loadChatMessages: () => persisted } });
let job, operations = [], modelCalls = 0, staged = 0, malformed = false, missing = false, loseStageResponse = false;
fetcher = async (url, init) => {
    if (url !== '/api/shared-memory/consolidation') throw Error('Unexpected egress: ' + url);
    const body = JSON.parse(init.body); operations.push(body.operation);
    assert.ok(!init.body.includes('PRIVATE_UNSENT')); assert.ok(!init.body.includes('PRIVATE_STORY'));
    if (body.operation === 'observe') {
        assert.ok(!init.body.includes('我周二'));
        return Response.json({ ok: true, ...base, conflicts: [], versions: Object.fromEntries(body.records.map(r => [r.id, { version: 1, digest: r.digest, retired: false }])) });
    }
    if (body.operation === 'prepare') {
        job = { id: webcrypto.randomUUID().replaceAll('-', ''), inputDigest: 'd'.repeat(64), inputs: records.map(r => ({ id: r.id, digest: r.digest, version: 1 })), previous: [], compression: true, summaryChars: 4000, state: 'prepared' };
        return Response.json({ ok: true, ...base, job });
    }
    if (body.operation === 'stage') { staged++; assert.equal(body.decision.jobId, job.id); if (loseStageResponse) throw new TypeError('synthetic lost response'); }
    return Response.json({ ok: true, ...base });
};
const modelConfig = { id: 'current-chat-config', provider: 'Custom', baseUrl: 'https://selected-model.fixture/v1', apiKey: 'synthetic-model-key', defaultModel: 'selected-chat-model', contextWindowTokens: 64000 };
const projection = await client.projectConsolidation(scope, persisted, modelConfig);
const messages = () => [{ role: 'system', content: '稳定规则与人格' }, { role: 'user', content: '请继续' }];
const decision = () => ({ protocol: 'float-consolidation/v1', jobId: job.id, inputDigest: job.inputDigest, decision: 'none', reason: '不值得长期保存', summary: [{ text: '谈到了周二的画展。', refs: ['r1'] }], facts: [] });
const helpers = load('../lib/api-helpers.ts');
const adapter = load('../lib/llm-provider-adapter.ts', { './api-helpers': helpers, './generation-parameters': { resolveEnabledGenerationParameters: () => new Set() } });
const layered = [{ role: 'system', content: 'stable-persona' }, { role: 'user', content: 'user-request' }];
protocol.insertConsolidationLayer(layered, { role: 'system', content: 'dynamic-memory-task' });
assert.equal(layered[0].content, 'stable-persona');
const anthropic = adapter.buildProviderRequest({ ...modelConfig, provider: 'Anthropic', baseUrl: undefined }, null, layered);
assert.ok(anthropic.body.system.includes('dynamic-memory-task')); assert.equal(anthropic.body.messages[0].content[0].text, 'user-request');
class Macro { expand(text) { return text; } }
const ephemeral = load('../lib/xinchao-ephemeral.ts');
const heartChat = load('../lib/xinchao-chat.ts', { './xinchao-ephemeral': ephemeral, './kv-db': { registerKvMigration: noop, kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value) } });
const engine = load('../lib/chat-engine.ts', { './consolidation-protocol': protocol, './consolidation-budget': budget,
    './xinchao-chat': heartChat, './xinchao-ephemeral': ephemeral,
    './llm-provider-adapter': adapter,
    './llm-http': { fetchLlmPayload: async (request, options) => {
        assert.equal(request.body.model, modelConfig.defaultModel); assert.ok(request.url.startsWith('https://selected-model.fixture/'));
        assert.ok(JSON.stringify(request.body).includes('本轮对话整理任务')); assert.ok(!JSON.stringify(request.body).includes('PRIVATE_UNSENT'));
        if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        modelCalls++;
        const block = missing ? '' : protocol.DECISION_OPEN + (malformed ? '{broken' : JSON.stringify(decision())) + protocol.DECISION_CLOSE;
        const content = (manualOnly ? '' : '可以呀。') + block;
        if (request.body.stream) {
            const lines = Array.from(content, character => 'data: ' + JSON.stringify({ choices: [{ delta: { content: character } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
            return new Response(lines, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    } },
    './sse-json': load('../lib/sse-json.ts'), './macro-engine': { MacroEngine: Macro, postProcessTrim: text => text },
    './chat-plugin-hooks': { runChatPluginTransform: async (_event, payload) => payload, emitChatPluginEvent: noop },
    './llm-prompt-assembler': { applyOutputRegex: text => text }, './chat-avatar-intent': { applyWithProtectedAvatarDecisionMarkers: (text, transform) => transform(text) },
    './content-tag-utils': { mergeAppTags: () => [], getActiveAppTags: () => [] },
});
for (const mode of ['json', 'sse', 'native-json', 'native-sse']) {
    const llmMessages = messages(), run = await client.beginConsolidation(projection, modelConfig, null, llmMessages);
    const before = modelCalls; let visible = '';
    try {
        let output;
        const options = { privateMemory: run, skipOutputRegex: true, debugSessionId: scope.sessionId };
        if (mode === 'json') output = await engine.sendLLMRequest(modelConfig, null, llmMessages, [], undefined, options);
        if (mode === 'sse') output = (await engine.sendLLMStreamRequest(modelConfig, null, llmMessages, [], undefined, options, { onDelta: text => { visible += text; } })).content;
        if (mode === 'native-json') output = (await engine.sendLLMToolRequest(modelConfig, null, llmMessages, [], [], undefined, options)).content;
        if (mode === 'native-sse') output = (await engine.sendLLMToolStreamRequest(modelConfig, null, llmMessages, [], [], undefined, options, { onDelta: text => { visible += text; } })).content;
        assert.equal(output, '可以呀。'); if (mode.includes('sse')) assert.equal(visible, '可以呀。');
        await run.finish(); assert.equal(modelCalls - before, 1, 'No auxiliary summary inference');
    } finally { await run.close(); }
}
assert.equal(staged, 4);
const manualMessages = messages(), manualRun = await client.beginConsolidation(projection, modelConfig, null, manualMessages, undefined, true);
manualOnly = true; const manualBefore = modelCalls;
try {
    assert.equal(await engine.sendLLMRequest(modelConfig, null, manualMessages, [], undefined, { privateMemory: manualRun, skipOutputRegex: true }), '');
    await manualRun.finish(); assert.equal(modelCalls - manualBefore, 1);
} finally { await manualRun.close(); manualOnly = false; }
paused = true;
await assert.rejects(client.beginConsolidation(projection, modelConfig, null, messages(), undefined, true), /暂停程序写入/);
paused = false;
for (const failure of ['missing', 'malformed', 'cancel']) {
    const controller = new AbortController(), llmMessages = messages(), run = await client.beginConsolidation(projection, modelConfig, null, llmMessages, controller.signal);
    missing = failure === 'missing'; malformed = failure === 'malformed'; const before = modelCalls, writesBefore = staged;
    try {
        await engine.sendLLMRequest(modelConfig, null, llmMessages, [], undefined, { privateMemory: run, skipOutputRegex: true });
        if (failure === 'cancel') controller.abort();
        if (failure === 'cancel') await run.finish(); else await assert.rejects(run.finish());
    } finally { await run.close(); }
    assert.equal(staged, writesBefore); assert.equal(modelCalls - before, 1);
}
missing = malformed = false;
const pendingRun = await client.beginConsolidation(projection, modelConfig, null, messages());
pendingRun.capture('可以呀。' + protocol.DECISION_OPEN + JSON.stringify(decision()) + protocol.DECISION_CLOSE);
loseStageResponse = true; const beforeAbandon = operations.filter(op => op === 'abandon').length;
await assert.rejects(pendingRun.finish()); await pendingRun.close();
assert.equal(operations.filter(op => op === 'abandon').length, beforeAbandon, 'Ambiguous staged write stays recoverable');
loseStageResponse = false;
assert.equal(await client.beginConsolidation(projection, { ...modelConfig, contextWindowTokens: undefined }, null, messages()), undefined);
assert.throws(() => budget.guardConsolidationBudget({ body: { messages: [{ content: 'x'.repeat(9000) }] }, providerKind: 'openai-compatible' }, { ...modelConfig, contextWindowTokens: 4096 }), /超过模型窗口/);
// Summary projections keep both recent targets and only replace covered sources.
const summaryProjection = { ...base, config: { ...base.config, recentGroups: 1, recentTokens: 1 }, summary: [{ text: '旧上下文', sources: [{ id: records[0].id, digest: records[0].digest }] }] };
const priorFetcher = fetcher;
fetcher = async (url, init) => JSON.parse(init.body).operation === 'status' ? Response.json({ ok: true, ...summaryProjection }) : priorFetcher(url, init);
const projected = await client.projectConsolidation(scope, persisted, modelConfig);
assert.equal(projected.excluded, 1); assert.equal(persisted.length, 5); assert.ok(projected.history.some(m => m.id === 'reply-b'));
// Exercise the real same-origin owner proxy, not only the browser client.
const ownerApi = load('../lib/server/shared-memory.ts');
const ownerConfig = { baseUrl: 'https://owned-backend.fixture', password: 'synthetic-dashboard', accessToken: 'synthetic-owner-token-'.repeat(2), reviewToken: 'synthetic-review-token-'.repeat(2) };
const reviewApi = load('../lib/server/shared-memory-review.ts', { './shared-memory': ownerApi });
const ownerRoute = load('../app/api/shared-memory/consolidation/route.ts', { 'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/server/shared-memory': { ...ownerApi, readSharedMemoryConfig: () => ownerConfig }, '@/lib/server/shared-memory-review': reviewApi });
let remoteCalls = 0;
fetcher = async (url, init) => { remoteCalls++; assert.equal(url, ownerConfig.baseUrl + '/float-memory/v2/consolidation'); assert.equal(init.headers.Authorization, 'Bearer ' + ownerConfig.reviewToken); assert.equal(init.redirect, 'error'); return Response.json({ ok: true, ...base }); };
const request = (origin, authorized, raw = JSON.stringify({ operation: 'status', scope })) => new Request('https://float.fixture/api/shared-memory/consolidation', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(authorized ? { 'x-float-memory-access-token': ownerConfig.accessToken } : {}) }, body: raw });
assert.equal((await ownerRoute.POST(request('https://other.fixture', true))).status, 403);
assert.equal((await ownerRoute.POST(request('https://float.fixture', false))).status, 401);
assert.equal(remoteCalls, 0);
assert.equal((await ownerRoute.POST(request('https://float.fixture', true))).status, 200);
assert.equal((await ownerRoute.POST(request('https://float.fixture', true, JSON.stringify({ text: 'x'.repeat(256 * 1024) } )))).status, 413);
assert.equal(remoteCalls, 1);
console.log('Consolidation: sent-message grouping, cross-role scopes, private stream filtering, all four real HTTP paths, selected-model single generation, missing/malformed/cancel retention, ambiguous-write recovery and context estimates passed.');
