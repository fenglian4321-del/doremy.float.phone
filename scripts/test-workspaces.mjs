// Real work backend + owner proxy + client + provider adapters/usage. Synthetic only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url), noop = () => {}, kv = new Map();
let network = async () => { throw Error('Unexpected network'); };
function load(relative, mocks = {}, strict = false) {
    const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require: name => {
        if (mocks[name]) return mocks[name];
        if (name.startsWith('node:')) return require(name);
        if (strict) throw Error('Unexpected work dependency: ' + name);
        return new Proxy({}, { get: () => noop });
    }, process: { env: {} }, console, window: {}, crypto: webcrypto, fetch: (...args) => network(...args), URL, URLSearchParams, Request, Response, Headers, Blob, ReadableStream, TextEncoder, TextDecoder, AbortController, AbortSignal, DOMException, Error, TypeError, setInterval, clearInterval, setTimeout, clearTimeout, Date, Math, Promise, JSON }, { filename: relative });
    return module.exports;
}
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const child = spawn(process.env.FLOAT_TEST_PYTHON || 'python', [fileURLToPath(new URL('../tools/float-memory-review/workspace_test_host.py', import.meta.url))], { windowsHide: true, env: { ...env, PYTHONUTF8: '1', ...(process.env.FLOAT_TEST_WORK_DIR ? { FLOAT_TEST_WORK_DIR: process.env.FLOAT_TEST_WORK_DIR } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', data => { stderr += data; });
const port = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Synthetic backend startup failed: ' + stderr)), 10000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); reject(Error('Synthetic backend exited: ' + code + ' ' + stderr)); });
    child.stdout.on('data', data => { output += data; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim()).port); } });
});
const owner = load('../lib/server/shared-memory.ts');
const config = { baseUrl: 'http://127.0.0.1:' + port, password: 'synthetic-dashboard', accessToken: 'synthetic-work-owner-token-'.repeat(2), reviewToken: 'synthetic-work-service-token-only' };
const review = load('../lib/server/shared-memory-review.ts', { './shared-memory': owner });
const route = load('../app/api/shared-memory/workspaces/route.ts', { 'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } }, '@/lib/server/shared-memory': { ...owner, readSharedMemoryConfig: () => config }, '@/lib/server/shared-memory-review': review }, true);
const privateRoute = load('../app/api/shared-memory/private-space/route.ts', { 'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } }, '@/lib/server/shared-memory': { ...owner, readSharedMemoryConfig: () => config }, '@/lib/server/shared-memory-review': review }, true);
const db = { kvGet: k => kv.get(k), kvSet: (k, v) => kv.set(k, v), kvRemove: k => kv.delete(k), registerDynamicPrefix: noop, registerKvMigration: noop };
const tokens = load('../lib/token-usage.ts'), ledger = load('../lib/usage-ledger.ts', { './kv-db': db }), usage = load('../lib/usage-fetch.ts', { './usage-ledger': ledger, './token-usage': tokens });
const helpers = load('../lib/api-helpers.ts', { './usage-fetch': usage, './token-usage': tokens });
const adapter = load('../lib/llm-provider-adapter.ts', { './api-helpers': helpers, './generation-parameters': { resolveEnabledGenerationParameters: () => new Set() }, './token-usage': tokens });
const delta = adapter.parseProviderStreamDelta('gemini', { candidates: [{ content: { parts: [{ functionCall: { id: 'stream-call-a', name: 'workspace_list_files', args: {} }, thoughtSignature: 'stream-signature' }] } }] });
assert.equal(delta.toolCallDeltas[0].id, 'stream-call-a'); assert.equal(delta.toolCallDeltas[0].providerCallId, 'stream-call-a');
const legacy = adapter.parseProviderResponse('gemini', { candidates: [{ content: { parts: [{ functionCall: { name: 'workspace_list_files', args: {} } }] } }] }).toolCalls[0];
assert.ok(legacy.id.startsWith('gemini_')); assert.equal(legacy.providerCallId, undefined);
const oldRequest = adapter.buildProviderRequest({ id: 'old', provider: 'Google', apiKey: 'synthetic', defaultModel: 'synthetic' }, null, [{ role: 'user', content: 'list' }, { role: 'assistant', content: '', toolCalls: [legacy] }, { role: 'tool', name: legacy.name, toolCallId: legacy.id, content: '{}' }], { tools: [{ name: legacy.name, description: 'test', parameters: { type: 'object', properties: {} } }] });
const oldParts = oldRequest.body.contents.flatMap(m => m.parts);
assert.equal(oldParts.find(p => p.functionResponse).functionResponse.id, undefined);
assert.equal(Object.keys(oldParts.find(p => p.functionCall).functionCall.args).length, 0);
const http = load('../lib/llm-http.ts', { './usage-fetch': usage });
const budget = load('../lib/consolidation-budget.ts', { './token-counter': load('../lib/token-counter.ts') });
const client = load('../lib/workspace-client.ts', { './kv-db': db, './llm-provider-adapter': adapter, './consolidation-budget': budget, './llm-http': http, './phone-file-tools': { getPhoneToolSession: () => null, phoneToolRunPending: () => false, clearPhoneToolRun: noop, disablePhoneTools: noop } }, true);
// Exercise the actual entry wrapper: a remembered work mode renders no life subtree.
const bankSource = ts.createSourceFile('bank.tsx', readFileSync(new URL('../components/memory/memory-bank-page.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wrapper = bankSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'MemoryBankPage').getText(bankSource);
const wrapperCode = ts.transpileModule(wrapper, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
let remembered = 'work';
const wrapperModule = { exports: {} }, Work = () => {}, Life = () => {};
vm.runInNewContext(wrapperCode, { module: wrapperModule, exports: wrapperModule.exports, require: () => ({ jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' }), useState: init => [typeof init === 'function' ? init() : init, value => { remembered = value; }], spaceUiMode: () => remembered, setSpaceUiMode: value => { remembered = value; }, WorkspacePanel: Work, LifeMemoryBankPage: Life, workspaceStyles: { entry: 'entry' } });
const opened = wrapperModule.exports.MemoryBankPage({ view: 'list' }); assert.equal(opened.type, Work);
assert.equal(opened.props.kind, 'work');
remembered = 'private'; assert.equal(wrapperModule.exports.MemoryBankPage({ view: 'list' }).props.kind, 'private');
opened.props.onBack(); assert.equal(remembered, 'life'); assert.equal(wrapperModule.exports.MemoryBankPage({ view: 'list' }).type, 'Fragment');
let modelRequests = 0, mode = 'normal', lostBegin = false, lostFinish = false, workRequests = [], wire = [];
network = async (url, init) => {
    if (url === '/api/shared-memory/workspaces' || url === '/api/shared-memory/private-space') {
        const body = JSON.parse(init.body); workRequests.push(body);
        const handler = url.endsWith('/private-space') ? privateRoute : route;
        const response = await handler.POST(new Request('https://float.fixture' + url, { ...init, headers: { ...init.headers, Origin: 'https://float.fixture', 'x-float-memory-access-token': config.accessToken } }));
        if (lostBegin && ['begin', 'compress_begin'].includes(body.operation)) {
            lostBegin = false;
            const accepted = await response.clone().json();
            // A lost acknowledgement may be followed by cancellation before
            // the user recovers. Recovery must adopt, never use an old lease.
            const cancelled = await handler.POST(new Request('https://float.fixture' + url, { ...init, headers: { ...init.headers, Origin: 'https://float.fixture', 'x-float-memory-access-token': config.accessToken }, body: JSON.stringify({ operation: 'cancel', workspaceId: body.workspaceId, runId: accepted.run.id, claim: body.claim }) }));
            assert.equal(cancelled.status, 200);
            throw new TypeError('synthetic lost begin response');
        }
        if (lostFinish && body.operation === 'compress_finish') { lostFinish = false; throw new TypeError('synthetic lost summary finish response'); }
        return response;
    }
    if (url === config.baseUrl + '/float-memory/v2/workspaces' || url === config.baseUrl + '/float-memory/v2/private_spaces') return fetch(url, init);
    const parsed = new URL(url);
    if (['selected-work.fixture', 'api.anthropic.com', 'generativelanguage.googleapis.com'].includes(parsed.hostname)) {
        modelRequests++; const body = JSON.parse(init.body); wire.push(body);
        assert.ok(!init.body.includes('PRIVATE_LIFE_SENTINEL'));
        assert.ok(!init.body.includes('memory_consolidation'));
        const protocol = parsed.hostname === 'api.anthropic.com' ? 'anthropic' : parsed.hostname === 'generativelanguage.googleapis.com' ? 'gemini' : 'openai';
        if (mode.startsWith('summary')) {
            assert.ok(!body.tools?.length, 'Compression never declares file/life tools');
            if (mode === 'summary_error') throw new TypeError('synthetic summary outage');
            const text = protocol === 'gemini' ? [body.systemInstruction?.parts?.map(p => p.text).join('\n'), ...body.contents.flatMap(m => m.parts.map(p => p.text))] : [...(Array.isArray(body.system) ? body.system.map(p => p.text) : [body.system]), ...body.messages.map(m => typeof m.content === 'string' ? m.content : m.content.map(p => p.text).join('\n'))];
            const source = JSON.parse(text.find(t => t?.startsWith('{"previous":')));
            const runId = text.join('\n').match(/"runId":"([a-f0-9]+)"/)[1];
            const refs = mode === 'summary_bad' ? ['life-forbidden'] : [source.records[0].id, ...(source.previous ? ['previous'] : [])];
            const reply = JSON.stringify({ protocol: 'float-space-summary/v1', runId, segments: [{ text: 'SYNTHETIC_CONTEXT_SUMMARY', refs }] });
            if (protocol === 'anthropic') return Response.json({ content: [{ type: 'text', text: reply }], usage: { input_tokens: 20, output_tokens: 10 } });
            if (protocol === 'gemini') return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: reply }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } });
            return Response.json({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
        }
        const declarations = protocol === 'anthropic' ? body.tools : protocol === 'gemini' ? body.tools?.flatMap(t => t.functionDeclarations || []) : body.tools?.map(t => t.function);
        const privateKind = declarations?.some(t => t.name.startsWith('private_'));
        const count = protocol === 'anthropic' ? body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'tool_result').length : protocol === 'gemini' ? body.contents.flatMap(m => m.parts).filter(p => p.functionResponse).length : body.messages.filter(m => m.role === 'tool').length;
        const hasResult = mode === 'repeat' ? count >= 8 : count > 0;
        const name = mode === 'forbidden' ? 'float_memory_pulse' : (privateKind ? 'private_' : 'workspace_') + (mode === 'list' ? 'list_files' : 'write_file');
        const args = mode === 'list' ? {} : { path: privateKind ? 'diary/entry.md' : mode === 'repeat' ? `notes/step-${count}.md` : 'notes/plan.md', content: privateKind ? 'PRIVATE_DIARY_SYNTHETIC' : 'WORK_ONLY_SYNTHETIC', baseVersion: 0 };
        if (count && mode === 'normal') {
            if (protocol === 'openai') assert.equal(body.messages.find(m => m.role === 'tool').tool_call_id, 'call-a');
            if (protocol === 'anthropic') assert.equal(body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'tool_result').tool_use_id, 'call-a');
            if (protocol === 'gemini') {
                const parts = body.contents.flatMap(m => m.parts);
                assert.equal(parts.find(p => p.functionResponse).functionResponse.id, 'call-a');
                assert.equal(parts.find(p => p.functionCall).functionCall.id, 'call-a');
                assert.equal(parts.find(p => p.functionCall).thoughtSignature, 'synthetic-signature');
            }
        }
        if (count && mode === 'list' && protocol === 'gemini') assert.equal(Object.keys(body.contents.flatMap(m => m.parts).find(p => p.functionCall).functionCall.args).length, 0);
        const reply = privateKind ? '私人日记已保存，不作为生活事实。' : '文件已保存在当前服务端工作区。';
        if (mode === 'network_error') throw new TypeError('synthetic provider outage');
        if (mode === 'cancel') { throw new DOMException('cancelled', 'AbortError'); }
        if (protocol === 'anthropic') return Response.json({ id: 'synthetic', type: 'message', role: 'assistant', content: mode === 'plain' || hasResult ? [{ type: 'text', text: reply }] : [{ type: 'tool_use', id: 'call-a', name, input: args }], stop_reason: hasResult ? 'end_turn' : 'tool_use', usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 3 } });
        if (protocol === 'gemini') return Response.json({ candidates: [{ content: { role: 'model', parts: mode === 'plain' || hasResult ? [{ text: reply }] : [{ functionCall: { id: 'call-a', name, args }, thoughtSignature: 'synthetic-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 } });
        return Response.json({ choices: [{ message: mode === 'plain' || hasResult ? { content: reply } : { content: '', tool_calls: [{ id: 'call-a', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: hasResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
    }
    throw Error('Work attempted an unexpected endpoint: ' + url);
};
const model = { id: 'selected-work-api', provider: 'Custom', baseUrl: 'https://selected-work.fixture/v1', apiKey: 'synthetic-model-key', defaultModel: 'selected-work-model', enableNativeTools: true, enableImageRecognition: false, enableImageGeneration: false, contextWindowTokens: 64000 };
const create = async title => (await client.workspaceCall('create', { title, clientKey: webcrypto.randomUUID() })).workspace;
try {
    for (const provider of ['Custom', 'Anthropic', 'Google']) {
        const workspace = await create('Synthetic ' + provider), chosen = { ...model, provider, baseUrl: provider === 'Custom' ? model.baseUrl : undefined };
        const before = modelRequests;
        const result = await client.runWorkspaceChat(workspace, chosen, '写一份工作计划', new AbortController().signal);
        assert.equal(result.run.state, 'complete'); assert.equal(result.workspace.messages.length, 2); assert.equal(modelRequests - before, 2, 'Tool choice + return to the same model');
        assert.equal(result.workspace.files[0].version, 1);
        const read = await client.workspaceCall('read_file', { workspaceId: workspace.id, path: 'notes/plan.md' }); assert.equal(read.result.content, 'WORK_ONLY_SYNTHETIC');
        assert.ok(workRequests.some(r => r.operation === 'tool' && r.callId === 'call-a'));
    }
    mode = 'plain'; const simple = await create('One request'), beforePlain = modelRequests;
    const firstGeneration = client.runWorkspaceChat(simple, model, '普通工作问题', new AbortController().signal);
    await assert.rejects(client.runWorkspaceChat(simple, model, '重复点击', new AbortController().signal), /已有本机生成/);
    await firstGeneration;
    assert.equal(modelRequests - beforePlain, 1, 'No forced planner/summary request');
    mode = 'list'; await client.runWorkspaceChat(await create('Gemini empty args'), { ...model, provider: 'Google', baseUrl: undefined }, '列出工作文件', new AbortController().signal);
    mode = 'repeat'; const beforeRepeat = modelRequests;
    const repeatResult = await client.runWorkspaceChat(await create('Eight tool turns'), model, '进行8轮工作文件操作', new AbortController().signal);
    assert.equal(modelRequests - beforeRepeat, 9); assert.equal(repeatResult.workspace.files.length, 8);
    const unknownWindow = await create('Unknown window'), beforeUnknown = modelRequests;
    await assert.rejects(client.runWorkspaceChat(unknownWindow, { ...model, contextWindowTokens: undefined }, 'x', new AbortController().signal), /上下文窗口/);
    assert.equal(modelRequests, beforeUnknown);
    mode = 'forbidden'; const blocked = await create('Scope test');
    await assert.rejects(client.runWorkspaceChat(blocked, model, 'x', new AbortController().signal), /工作区外/);
    const blockedDetail = await client.workspaceCall('detail', { workspaceId: blocked.id }); assert.equal(blockedDetail.run.state, 'cancelled'); assert.equal(blockedDetail.workspace.files.length, 0);
    mode = 'plain'; await client.runWorkspaceChat(blockedDetail.workspace, model, null, new AbortController().signal);
    mode = 'network_error'; const failed = await create('Recover provider');
    await assert.rejects(client.runWorkspaceChat(failed, model, '待恢复工作消息', new AbortController().signal));
    const stopped = await client.workspaceCall('detail', { workspaceId: failed.id }); assert.equal(stopped.workspace.messages.length, 1); assert.equal(stopped.run.state, 'cancelled');
    await assert.rejects(client.runWorkspaceChat(stopped.workspace, { ...model, baseUrl: 'https://other.fixture' }, null, new AbortController().signal), /同一API/);
    mode = 'plain'; const resumed = await client.runWorkspaceChat(stopped.workspace, model, null, new AbortController().signal); assert.equal(resumed.workspace.messages.length, 2);
    lostBegin = true; const ambiguous = await create('Lost begin');
    await assert.rejects(client.runWorkspaceChat(ambiguous, model, 'NO_LOCAL_BODY_CACHE', new AbortController().signal));
    assert.ok(!JSON.stringify([...kv.values()]).includes('NO_LOCAL_BODY_CACHE'));
    const restored = await client.runWorkspaceChat(ambiguous, model, null, new AbortController().signal); assert.equal(restored.workspace.messages.length, 2);
    const replay = await client.workspaceCall('read_file', { workspaceId: simple.id, path: '../life' }).catch(e => e); assert.ok(replay instanceof Error);
    const usageRows = ledger.getUsageLedger(); assert.ok(usageRows.length > 0 && usageRows.every(r => r.source === 'work'));
    assert.ok(!JSON.stringify(usageRows).includes('WORK_ONLY_SYNTHETIC')); assert.ok(!JSON.stringify(usageRows).includes(model.apiKey));
    assert.equal((await route.POST(new Request('https://float.fixture/api/shared-memory/workspaces', { method: 'POST', headers: { Origin: 'https://evil.fixture' }, body: '{}' }))).status, 403);
    assert.equal((await route.POST(new Request('https://float.fixture/api/shared-memory/workspaces', { method: 'POST', headers: { Origin: 'https://float.fixture' }, body: '{}' }))).status, 401);
    mode = 'normal';
    const privateSpace = (await client.privateSpaceCall('create', { title: 'AI private journal', clientKey: simple.id })).workspace;
    const written = await client.runWorkspaceChat(privateSpace, model, '只根据本空间写一页日记', new AbortController().signal, undefined, 'private');
    assert.equal(written.workspace.mode, 'private'); assert.equal(written.workspace.files[0].path, 'diary/entry.md');
    await assert.rejects(client.workspaceCall('read_file', { workspaceId: simple.id, path: 'diary/entry.md' }));
    assert.equal((await client.privateSpaceCall('read_file', { workspaceId: simple.id, path: 'diary/entry.md' })).result.content, 'PRIVATE_DIARY_SYNTHETIC');
    const attachment = await client.privateSpaceCall('write_file', { workspaceId: simple.id, path: 'attachments/source.md', content: 'PRIVATE_SELECTED_ATTACHMENT', baseVersion: 0 });
    mode = 'plain';
    await client.runWorkspaceChat(attachment.workspace, model, '检查选中的材料', new AbortController().signal, undefined, 'private', [{ path: attachment.result.path, version: attachment.result.version }]);
    assert.ok(JSON.stringify(wire.at(-1)).includes('PRIVATE_SELECTED_ATTACHMENT'));
    assert.ok(!JSON.stringify([...kv.values()]).includes('PRIVATE_SELECTED_ATTACHMENT'));
    assert.ok(ledger.getUsageLedger().some(row => row.source === 'private'));
    for (const provider of ['Anthropic', 'Google']) {
        mode = 'normal';
        const room = (await client.privateSpaceCall('create', { title: 'Private ' + provider, clientKey: webcrypto.randomUUID() })).workspace;
        const result = await client.runWorkspaceChat(room, { ...model, provider, baseUrl: undefined }, '写本空间日记', new AbortController().signal, undefined, 'private');
        assert.equal(result.run.state, 'complete'); assert.equal(result.workspace.files[0].path, 'diary/entry.md');
    }
    await assert.rejects(client.runWorkspaceChat(privateSpace, model, 'wrong scope', new AbortController().signal), /作用域不匹配/);
    const callsBeforeInvalid = workRequests.length;
    await assert.rejects(client.spaceCall('life', 'list'), /未识别空间/);
    assert.equal(workRequests.length, callsBeforeInvalid);
    const attachments = load('../lib/space-attachments.ts', {}, true);
    const raw = new TextEncoder().encode('仅用于合成测试的UTF-8材料');
    const parsedAttachment = await attachments.readSpaceTextAttachment({ name: '材料'.repeat(90) + '.md', size: raw.byteLength, arrayBuffer: async () => raw.buffer });
    assert.ok(new TextEncoder().encode(parsedAttachment.path).byteLength <= 240);
    assert.equal(parsedAttachment.content, '仅用于合成测试的UTF-8材料');
    await assert.rejects(attachments.readSpaceTextAttachment({ name: 'x.pdf', size: 0, arrayBuffer: async () => new ArrayBuffer(0) }), /暂未接入/);
    await assert.rejects(attachments.readSpaceTextAttachment({ name: 'x.txt', size: 32769, arrayBuffer: async () => new ArrayBuffer(32769) }), /不会截断/);
    await assert.rejects(attachments.readSpaceTextAttachment({ name: 'x.txt', size: 1, arrayBuffer: async () => Uint8Array.of(255).buffer }), /UTF-8/);
    for (const kind of ['work', 'private']) for (const provider of ['Custom', 'Anthropic', 'Google']) {
        let room = (await client.spaceCall(kind, 'create', { title: 'Context fixture', clientKey: webcrypto.randomUUID() })).workspace;
        const chosen = { ...model, provider, baseUrl: provider === 'Custom' ? model.baseUrl : undefined };
        mode = 'plain';
        for (let i = 0; i < 6; i++) room = (await client.runWorkspaceChat(room, chosen, 'CONTEXT_SOURCE_' + i, new AbortController().signal, undefined, kind)).workspace;
        const original = JSON.stringify(room.messages), before = modelRequests;
        mode = 'summary';
        const compressed = await client.compressWorkspaceContext(room, chosen, false, new AbortController().signal, undefined, kind);
        assert.equal(modelRequests - before, 1); assert.equal(JSON.stringify(compressed.workspace.messages), original);
        assert.equal(compressed.workspace.context.summary.throughCount, 4); assert.equal(compressed.workspace.context.enabled, true);
        if (kind === 'private' && provider === 'Custom') {
            const oldPage = await privateRoute.POST(new Request('https://float.fixture/api/shared-memory/private-space', { method: 'POST', headers: { Origin: 'https://float.fixture', 'x-float-memory-access-token': config.accessToken }, body: JSON.stringify({ operation: 'detail', workspaceId: room.id }) }));
            assert.equal(oldPage.status, 409); assert.equal((await oldPage.json()).code, 'work_client_upgrade');
        }
        mode = 'plain';
        await client.runWorkspaceChat(compressed.workspace, chosen, 'NEXT_RAW_TURN', new AbortController().signal, undefined, kind);
        assert.ok(JSON.stringify(wire.at(-1)).includes('SYNTHETIC_CONTEXT_SUMMARY')); assert.ok(!JSON.stringify(wire.at(-1)).includes('CONTEXT_SOURCE_0')); assert.ok(JSON.stringify(wire.at(-1)).includes('CONTEXT_SOURCE_2'));
        if (kind === 'work' && provider === 'Custom') {
            await client.workspaceCall('write_file', { workspaceId: room.id, path: 'plan.md', content: 'v1', baseVersion: 0 });
            await client.workspaceCall('write_file', { workspaceId: room.id, path: 'plan.md', content: 'v2', baseVersion: 1 });
            const history = await client.workspaceCall('file_history', { workspaceId: room.id, path: 'plan.md' });
            assert.equal(history.fileHistory.versions.length, 2);
            const args = { workspaceId: room.id, path: 'plan.md', baseVersion: 2, targetVersion: 1, clientKey: webcrypto.randomUUID() };
            const restored = await client.workspaceCall('restore_file', args); assert.equal(restored.restored.version, 3);
            const replay = await client.workspaceCall('restore_file', args); assert.equal(replay.restored.replayed, true);
        }
    }
    let room = await create('Summary lost acknowledgement'); mode = 'plain';
    for (let i = 0; i < 6; i++) room = (await client.runWorkspaceChat(room, model, 'recovery-source-' + i, new AbortController().signal)).workspace;
    mode = 'summary'; lostBegin = true;
    const beforeLookup = modelRequests;
    await assert.rejects(client.compressWorkspaceContext(room, model, false, new AbortController().signal));
    assert.equal(modelRequests, beforeLookup);
    lostFinish = true;
    await assert.rejects(client.compressWorkspaceContext(room, model, true, new AbortController().signal));
    assert.equal(modelRequests, beforeLookup + 1);
    const confirmed = await client.compressWorkspaceContext(room, model, true, new AbortController().signal);
    assert.equal(confirmed.run.state, 'complete'); assert.equal(modelRequests, beforeLookup + 1, 'Lost commit confirmation never repeats a completed model call');
    mode = 'plain'; room = confirmed.workspace;
    for (let i = 0; i < 2; i++) room = (await client.runWorkspaceChat(room, model, 'new-source-' + i, new AbortController().signal)).workspace;
    mode = 'summary_bad';
    await assert.rejects(client.compressWorkspaceContext(room, model, false, new AbortController().signal));
    const bad = await client.workspaceCall('detail', { workspaceId: room.id });
    assert.equal(bad.run.state, 'cancelled'); assert.equal(bad.workspace.context.summary.version, 1);
    const cachedClient = await route.POST(new Request('https://float.fixture/api/shared-memory/workspaces', { method: 'POST', headers: { Origin: 'https://float.fixture', 'x-float-memory-access-token': config.accessToken }, body: JSON.stringify({ operation: 'detail', workspaceId: room.id }) }));
    assert.equal(cachedClient.status, 409); assert.equal((await cachedClient.json()).code, 'work_client_upgrade');
    await assert.rejects(client.runWorkspaceChat(bad.workspace, model, null, new AbortController().signal), /摘要任务/);
    await assert.rejects(client.compressWorkspaceContext(bad.workspace, { ...model, defaultModel: 'other' }, true, new AbortController().signal), /原API/);
    const beforeBudget = modelRequests;
    await assert.rejects(client.compressWorkspaceContext(bad.workspace, { ...model, contextWindowTokens: 1024 }, true, new AbortController().signal), /超过模型窗口/);
    assert.equal(modelRequests, beforeBudget);
    mode = 'summary'; const recovered = await client.compressWorkspaceContext(bad.workspace, model, true, new AbortController().signal); assert.equal(recovered.workspace.context.summary.version, 2);
    assert.ok(!JSON.stringify([...kv.values()]).includes('SYNTHETIC_CONTEXT_SUMMARY'));
    for (const reason of ['chat', 'tool_continuation', 'resume', 'manual_compression']) assert.ok(ledger.getUsageLedger().some(row => row.reason === reason), 'Actual request reason recorded: ' + reason);
    console.log('Work/private spaces: real SQLite/proxies/client + three provider chat/compression loops, file CAS/history/restore replay, explicit attachments, raw/history retention, scope/usage isolation, lost acknowledgements, invalid summary, window guard and recovery passed. Synthetic only.');
} finally { child.kill(); }
