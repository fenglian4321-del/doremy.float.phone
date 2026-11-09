// Actual browser runtime/provider adapters + owner proxies + synthetic SQLite backend.
// Native SAF and every model response are fixtures. No device/provider/account access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url), noop = () => {}, kv = new Map();
const window = { location: { origin: 'https://float.fixture' } };
let shell = false, network = async () => { throw Error('unexpected network'); };
function load(relative, mocks = {}, strict = true) {
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require: name => {
        if (mocks[name]) return mocks[name];
        if (name.startsWith('node:')) return require(name);
        if (strict) throw Error('Unexpected dependency: ' + name);
        return new Proxy({}, { get: () => noop });
    }, process: { env: {} }, window, crypto: webcrypto, fetch: (...args) => network(...args), URL, URLSearchParams, Request, Response, Headers, Blob, ReadableStream, TextEncoder, TextDecoder, AbortController, AbortSignal, DOMException, Error, TypeError, setInterval, clearInterval, setTimeout, clearTimeout, Date, Math, Promise, JSON }, { filename: relative });
    return module.exports;
}
const db = { kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value), kvRemove: key => kv.delete(key), registerDynamicPrefix: noop, registerKvMigration: noop };
const phone = load('../lib/scoped-phone-files.ts', { './kv-db': db, './shell-detect': { isShellEnvironment: () => shell } });
const tools = load('../lib/phone-file-tools.ts', { './kv-db': db, './scoped-phone-files': phone });
const tokens = load('../lib/token-usage.ts'), ledger = load('../lib/usage-ledger.ts', { './kv-db': db });
const usage = load('../lib/usage-fetch.ts', { './usage-ledger': ledger, './token-usage': tokens });
const helpers = load('../lib/api-helpers.ts', { './usage-fetch': usage, './token-usage': tokens }, false);
const adapter = load('../lib/llm-provider-adapter.ts', { './api-helpers': helpers, './generation-parameters': { resolveEnabledGenerationParameters: () => new Set() }, './token-usage': tokens });
const http = load('../lib/llm-http.ts', { './usage-fetch': usage });
const budget = load('../lib/consolidation-budget.ts', { './token-counter': load('../lib/token-counter.ts') });
const client = load('../lib/workspace-client.ts', { './kv-db': db, './phone-file-tools': tools, './llm-provider-adapter': adapter, './llm-http': http, './consolidation-budget': budget, './phone-device-tools':{getPhoneDeviceSession:()=>null,phoneDeviceRunPending:()=>false,clearPhoneDeviceRun:()=>{},disablePhoneDeviceTools:()=>{}},'./managed-mcp-session': { getManagedMcpSession: () => null, managedMcpSessionPreparing: () => false, managedMcpRunPending: () => false, clearManagedMcpRun: noop, disableManagedMcpSession: noop } });
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const child = spawn(process.env.FLOAT_TEST_PYTHON || 'python', [fileURLToPath(new URL('../tools/float-memory-review/workspace_test_host.py', import.meta.url))], { windowsHide: true, env: { ...env, PYTHONUTF8: '1', ...(process.env.FLOAT_TEST_WORK_DIR ? { FLOAT_TEST_WORK_DIR: process.env.FLOAT_TEST_WORK_DIR } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', bytes => { stderr += bytes; });
const port = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Fixture backend did not start: ' + stderr)), 10000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); reject(Error('Fixture backend exit ' + code + ': ' + stderr)); });
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim()).port); } });
});
const owner = load('../lib/server/shared-memory.ts', {}, false);
const config = { baseUrl: 'http://127.0.0.1:' + port, password: 'synthetic-dashboard', accessToken: 'synthetic-work-owner-token-'.repeat(2), reviewToken: 'synthetic-work-service-token-only' };
const review = load('../lib/server/shared-memory-review.ts', { './shared-memory': owner }, false);
const routes = Object.fromEntries(['workspaces', 'private-space'].map(name => [name, load('../app/api/shared-memory/' + name + '/route.ts', { 'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } }, '@/lib/server/shared-memory': { ...owner, readSharedMemoryConfig: () => config }, '@/lib/server/shared-memory-review': review })]));
const BODY = 'SYNTHETIC_PHONE_PRIVATE_BODY', NEW = 'SYNTHETIC_PHONE_NEW_BODY';
const sha = text => createHash('sha256').update(text).digest('hex'), scopeKey = scope => scope.mode + ':' + scope.workspaceId;
const nativeOps = [], files = new Map(), grants = new Map(), jobs = new Map(), traces = [], backendRequests = [];
let behavior = '', modelMode = 'normal', modelRequests = 0, stopDuringModel, abortOnRead, loseFinish = false;
const wire = value => JSON.stringify({ protocol: 'float-shell-files/v1', location: 'android_device', ...value });
const done = result => wire({ ok: true, state: 'complete', result }), fail = code => wire({ ok: false, code });
const native = {
    getScopedFilesCapabilities: () => wire({ ok: true, createOnly: true, maxTextBytes: 32768 }),
    requestScopedDirectory: () => { throw Error('AI must never invoke picker'); },
    submitScopedFiles: raw => {
        const body = JSON.parse(raw), key = scopeKey(body.scope); nativeOps.push(body);
        let result;
        const grant = grants.get(key), storage = files.get(key);
        if (body.operation === 'grants') result = done({ grants: grant ? [grant] : [] });
        else if (!grant || grant.id !== body.grantId) result = fail('grant_scope');
        else if (body.operation === 'list') result = done({ path: body.path, files: [...storage].filter(([path]) => !path.includes('/')).map(([name, content]) => ({ name, directory: false, bytes: Buffer.byteLength(content) })) });
        else if (body.operation === 'read') {
            const content = storage.get(body.path);
            result = content === undefined ? fail('file_missing') : done({ path: body.path, content, bytes: Buffer.byteLength(content), digest: sha(content) });
            if (behavior === 'revoke-read') grants.delete(key);
        } else if (body.operation === 'create') {
            if (storage.has(body.path)) result = fail('file_exists');
            else { storage.set(body.path, body.content); result = done({ created: true, path: body.path, bytes: Buffer.byteLength(body.content), digest: sha(body.content) }); }
        } else throw Error('Unexpected native action');
        if (behavior === 'wrong-path' && body.operation === 'read') result = done({ path: 'wrong.md', content: BODY, bytes: Buffer.byteLength(BODY), digest: sha(BODY) });
        if (behavior === 'wrong-location' && body.operation === 'read') result = JSON.stringify({ protocol: 'float-shell-files/v1', location: 'vps', ok: true, state: 'complete', result: {} });
        if (behavior === 'wrong-digest' && body.operation === 'create') result = done({ created: true, path: body.path, bytes: Buffer.byteLength(body.content), digest: '0'.repeat(64) });
        jobs.set(body.requestId, { scope: body.scope, result });
        if (behavior === 'lost-create' && body.operation === 'create') { behavior = ''; throw Error('content://PRIVATE_PROVIDER_EXCEPTION'); }
        if (behavior === 'pending-read' && body.operation === 'read') { setTimeout(() => abortOnRead?.abort(), 0); return wire({ ok: true, state: 'pending' }); }
        return result;
    },
    getScopedFilesResult: (raw, id) => { const job = jobs.get(id); return !job ? fail('request_missing') : JSON.stringify(job.scope) !== raw ? fail('grant_scope') : behavior === 'pending-read' ? wire({ ok: true, state: 'pending' }) : job.result; },
    verifyScopedFiles: (raw, id) => { nativeOps.push({ operation: 'verify' }); return native.getScopedFilesResult(raw, id); },
    cancelScopedFiles: () => { nativeOps.push({ operation: 'cancel' }); return fail('cancelled'); },
};
const model = { id: 'phone-api-fixture', provider: 'Custom', baseUrl: 'https://selected-phone.fixture/v1', apiKey: 'SYNTHETIC_KEY', defaultModel: 'synthetic-phone-model', enableNativeTools: true, contextWindowTokens: 64000 };
const resultsFrom = (body, protocol) => protocol === 'anthropic' ? body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result').map(part => ({ id: part.tool_use_id, value: JSON.parse(part.content) })) : protocol === 'gemini' ? body.contents.flatMap(message => message.parts).filter(part => part.functionResponse).map(part => ({ id: part.functionResponse.id, value: part.functionResponse.response })) : body.messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, value: JSON.parse(message.content) }));
network = async (url, init) => {
    if (url === '/api/shared-memory/workspaces' || url === '/api/shared-memory/private-space') {
        backendRequests.push(JSON.parse(init.body));
        const response = await routes[url.endsWith('/private-space') ? 'private-space' : 'workspaces'].POST(new Request('https://float.fixture' + url, { ...init, headers: { ...init.headers, Origin: 'https://float.fixture', 'x-float-memory-access-token': config.accessToken } }));
        if (loseFinish && JSON.parse(init.body).operation === 'finish') { loseFinish = false; throw new TypeError('Synthetic lost finish acknowledgement'); }
        return response;
    }
    if (url === config.baseUrl + '/float-memory/v2/workspaces' || url === config.baseUrl + '/float-memory/v2/private_spaces') return fetch(url, init);
    const hostname = new URL(url).hostname;
    assert.ok(['selected-phone.fixture', 'api.anthropic.com', 'generativelanguage.googleapis.com'].includes(hostname), 'No network execution fallback');
    modelRequests++;
    const protocol = hostname === 'api.anthropic.com' ? 'anthropic' : hostname === 'generativelanguage.googleapis.com' ? 'gemini' : 'openai';
    const body = JSON.parse(init.body), results = resultsFrom(body, protocol);
    const declarations = protocol === 'anthropic' ? body.tools : protocol === 'gemini' ? body.tools?.flatMap(tool => tool.functionDeclarations || []) : body.tools?.map(tool => tool.function);
    assert.ok(!init.body.includes('PRIVATE_LIFE_SENTINEL'));
    if (modelMode === 'plain') assert.ok(!declarations?.some(tool => tool.name.startsWith('phone_')));
    else if (modelMode !== 'limit' || results.length < 8) {
        assert.ok(declarations?.length >= 2 && declarations.every(tool => tool.name.startsWith('phone_')));
        for (const tool of declarations) {
            const schema = tool.parameters || tool.input_schema;
            assert.ok(!Object.keys(schema.properties).some(name => ['scope', 'grantId', 'workspaceId', 'uri', 'operation'].includes(name)));
            if (protocol !== 'gemini') assert.equal(schema.additionalProperties, false);
        }
        if (modelMode === 'readonly') assert.equal(declarations.length, 2);
    } else assert.ok(!declarations?.length);
    for (const [index, result] of results.entries()) {
        if (modelMode === 'limit') continue;
        assert.equal(result.id, ['phone-list', 'phone-read', 'phone-create'][index]);
        const raw = typeof result.value === 'object' && result.value?.protocol ? result.value : result.value?.result;
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        assert.equal(value.protocol, 'float-phone-tools/v1'); assert.equal(value.location, 'android_device'); assert.equal(value.ok, true); assert.ok(value.receiptId);
        if (index === 1) assert.equal(value.content, BODY);
    }
    if (protocol === 'gemini' && results.length) {
        const parts = body.contents.flatMap(message => message.parts);
        assert.equal(parts.find(part => part.functionCall).thoughtSignature, 'synthetic-signature');
        assert.equal(parts.find(part => part.functionCall).functionCall.id, 'phone-list');
    }
    let calls = [], reply = '';
    if (modelMode === 'plain' || (modelMode === 'readonly' ? results.length >= 2 : modelMode === 'limit' ? results.length >= 8 : results.length >= 3)) reply = '合成手机任务结束，按回执核对。';
    else if (modelMode === 'limit') calls = [{ id: 'step-' + results.length, name: 'phone_list_files', args: { path: '' } }];
    else if (modelMode === 'forbidden') calls = [{ id: 'forbidden', name: 'workspace_write_file', args: { path: 'x.md', content: NEW, baseVersion: 0 } }];
    else if (modelMode === 'duplicate') calls = [{ id: 'same', name: 'phone_list_files', args: { path: '' } }, { id: 'same', name: 'phone_read_file', args: { path: 'note.md' } }];
    else calls = [results.length === 0 ? { id: 'phone-list', name: 'phone_list_files', args: { path: '' } } : results.length === 1 ? { id: 'phone-read', name: 'phone_read_file', args: { path: 'note.md' } } : { id: 'phone-create', name: 'phone_create_file', args: { path: 'new.md', content: NEW } }];
    if (stopDuringModel) { stopDuringModel(); stopDuringModel = undefined; }
    if (protocol === 'anthropic') return Response.json({ content: reply ? [{ type: 'text', text: reply }] : calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })), usage: { input_tokens: 10, output_tokens: 5 } });
    if (protocol === 'gemini') return Response.json({ candidates: [{ content: { parts: reply ? [{ text: reply }] : calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: call.args }, thoughtSignature: 'synthetic-signature' })) } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
    return Response.json({ choices: [{ message: { content: reply, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
};
const create = async (kind = 'work') => (await client.spaceCall(kind, 'create', { title: 'Synthetic phone tools', clientKey: webcrypto.randomUUID() })).workspace;
const setup = async (kind = 'work', writable = true) => {
    const workspace = await create(kind), scope = { mode: kind, workspaceId: workspace.id }, grant = { id: 'grant-' + workspace.id, label: 'Synthetic directory', readable: true, writable };
    grants.set(scopeKey(scope), grant); files.set(scopeKey(scope), new Map([['note.md', BODY]]));
    return { workspace, scope, grant };
};
const fileActions = () => nativeOps.filter(op => ['list', 'read', 'create'].includes(op.operation));
try {
    await assert.rejects(tools.enablePhoneTools({ mode: 'life', workspaceId: 'fixture' }, 'x', false), /工作或私人/);
    const absent = await setup(); modelMode = 'plain';
    await assert.rejects(tools.enablePhoneTools(absent.scope, absent.grant.id, false));
    await client.runWorkspaceChat(absent.workspace, model, 'No native bridge', new AbortController().signal);
    assert.equal(nativeOps.length, 0);
    shell = true; window.AndroidShell = native;
    const defaultOff = await setup(); const defaultOffBefore = nativeOps.length;
    await client.runWorkspaceChat(defaultOff.workspace, model, 'Bridge present, default off', new AbortController().signal);
    assert.equal(nativeOps.length, defaultOffBefore);
    await assert.rejects(tools.enablePhoneTools(absent.scope, '', false), /明确选择/); assert.equal(nativeOps.length, 0);
    const old = native.getScopedFilesCapabilities;
    native.getScopedFilesCapabilities = () => JSON.stringify({ ok: true, protocol: 'old', location: 'android_device' });
    await assert.rejects(tools.enablePhoneTools(absent.scope, absent.grant.id, false)); native.getScopedFilesCapabilities = old;
    for (const kind of ['work', 'private']) for (const provider of ['Custom', 'Anthropic', 'Google']) {
        const { workspace, scope, grant } = await setup(kind); modelMode = 'normal';
        const selected = { ...model, provider, baseUrl: provider === 'Custom' ? model.baseUrl : undefined };
        const session = await tools.enablePhoneTools(scope, grant.id, true); assert.ok(session.matches(scope));
        const before = modelRequests, requests = backendRequests.length;
        const result = await client.runWorkspaceChat(workspace, selected, 'Read and save synthetic text', new AbortController().signal, undefined, kind, [], item => traces.push(item));
        assert.equal(result.run.state, 'complete'); assert.equal(modelRequests - before, 4);
        assert.equal(files.get(scopeKey(scope)).get('new.md'), NEW); assert.equal(result.workspace.files.length, 0);
        assert.equal(tools.getPhoneToolSession(scope), null); assert.equal(tools.phoneToolRunPending(scope, result.run.id), false);
        assert.ok(!backendRequests.slice(requests).some(body => ['turn', 'tool'].includes(body.operation)));
    }
    const readonly = await setup('private', false); modelMode = 'readonly';
    await tools.enablePhoneTools(readonly.scope, readonly.grant.id, false);
    await client.runWorkspaceChat(readonly.workspace, model, 'Read only', new AbortController().signal, undefined, 'private');
    const cross = await setup('private'); await assert.rejects(tools.enablePhoneTools(cross.scope, absent.grant.id, false));
    const gated = await setup(); await tools.enablePhoneTools(gated.scope, gated.grant.id, false); const beforeGated = modelRequests;
    await assert.rejects(client.runWorkspaceChat(gated.workspace, { ...model, enableNativeTools: false }, 'Disabled API tools', new AbortController().signal), /关闭了原生工具/);
    assert.equal(modelRequests, beforeGated); tools.disablePhoneTools(gated.scope);
    for (const mode of ['forbidden', 'duplicate']) {
        const fixture = await setup(); modelMode = mode; await tools.enablePhoneTools(fixture.scope, fixture.grant.id, true); const before = fileActions().length;
        await assert.rejects(client.runWorkspaceChat(fixture.workspace, model, 'Reject batch', new AbortController().signal));
        assert.equal(fileActions().length, before);
    }
    const rule = await setup(); const runtime = await tools.enablePhoneTools(rule.scope, rule.grant.id, true); const signal = new AbortController().signal;
    const execute = async (id, name, args) => JSON.parse((await runtime.execute({ id, name, args }, signal, value => traces.push(value))).content);
    assert.equal((await execute('read-before', 'phone_read_file', { path: 'note.md' })).code, 'read_first');
    assert.equal((await execute('create-before', 'phone_create_file', { path: 'new.md', content: NEW })).code, 'read_first');
    assert.equal((await execute('extra-scope', 'phone_read_file', { path: 'note.md', scope: 'life' })).code, 'invalid_request');
    for (const badPath of ['../outside.md', 'content://outside.md', '/root.md', 'notes/%2e%2e/x.md', 'x\\a.md', '\u202eevil.md']) assert.equal((await execute('invalid-' + webcrypto.randomUUID(), 'phone_read_file', { path: badPath })).code, 'invalid_path');
    await execute('rule-list', 'phone_list_files', { path: '' });
    const creates = nativeOps.filter(op => op.operation === 'create').length;
    assert.equal((await execute('rule-exists', 'phone_create_file', { path: 'note.md', content: NEW })).code, 'file_exists');
    assert.equal(nativeOps.filter(op => op.operation === 'create').length, creates);
    files.get(scopeKey(rule.scope)).set('race.md', 'appeared after first list');
    assert.equal((await execute('rule-race', 'phone_create_file', { path: 'race.md', content: NEW })).code, 'file_exists');
    assert.equal(nativeOps.filter(op => op.operation === 'create').length, creates);
    tools.disablePhoneTools(rule.scope);
    const origin = await setup(); const originSession = await tools.enablePhoneTools(origin.scope, origin.grant.id, false); window.location.origin = 'https://other.fixture';
    await assert.rejects(originSession.check()); window.location.origin = 'https://float.fixture'; tools.disablePhoneTools(origin.scope);
    for (const flag of ['revoke-read', 'wrong-path', 'wrong-location', 'wrong-digest', 'lost-create']) {
        const fixture = await setup(); modelMode = 'normal'; behavior = flag; await tools.enablePhoneTools(fixture.scope, fixture.grant.id, true);
        const before = modelRequests, createsBefore = nativeOps.filter(op => op.operation === 'create').length;
        await assert.rejects(client.runWorkspaceChat(fixture.workspace, model, 'Stop uncertain operation', new AbortController().signal), error => !error.message.includes('content://'));
        const expectedCalls = ['wrong-digest', 'lost-create'].includes(flag) ? 3 : 2;
        assert.equal(modelRequests - before, expectedCalls);
        assert.equal(nativeOps.filter(op => op.operation === 'create').length - createsBefore, expectedCalls === 3 ? 1 : 0);
        const detail = await client.spaceCall('work', 'detail', { workspaceId: fixture.workspace.id }); assert.equal(detail.run.state, 'cancelled');
        assert.equal(tools.phoneToolRunPending(fixture.scope, detail.run.id), true);
        const beforeResume = modelRequests;
        await assert.rejects(client.runWorkspaceChat(detail.workspace, model, null, new AbortController().signal), /不能自动重放/); assert.equal(modelRequests, beforeResume);
        behavior = '';
        if (flag === 'lost-create') {
            assert.ok(phone.phoneFileReceipt(fixture.scope));
            assert.equal((await phone.recoverPhoneFileCall(fixture.scope)).created, true);
            assert.equal(nativeOps.filter(op => op.operation === 'create').length - createsBefore, 1);
        }
        if (phone.phoneFileReceipt(fixture.scope)) phone.abandonPhoneFileWait(fixture.scope);
    }
    const cancel = await setup(); modelMode = 'normal'; behavior = 'pending-read'; abortOnRead = new AbortController();
    await tools.enablePhoneTools(cancel.scope, cancel.grant.id, false); const cancelBefore = modelRequests;
    await assert.rejects(client.runWorkspaceChat(cancel.workspace, model, 'Cancel waiting', abortOnRead.signal));
    assert.equal(modelRequests - cancelBefore, 2); behavior = ''; phone.abandonPhoneFileWait(cancel.scope);
    const inflight = await setup(); modelMode = 'normal'; await tools.enablePhoneTools(inflight.scope, inflight.grant.id, true);
    const inflightBefore = fileActions().length; stopDuringModel = () => tools.disablePhoneTools(inflight.scope);
    await assert.rejects(client.runWorkspaceChat(inflight.workspace, model, 'Disable during model', new AbortController().signal)); assert.equal(fileActions().length, inflightBefore);
    const limit = await setup(); modelMode = 'limit'; await tools.enablePhoneTools(limit.scope, limit.grant.id, false); const limitBefore = modelRequests;
    await client.runWorkspaceChat(limit.workspace, model, 'Bound loop', new AbortController().signal); assert.equal(modelRequests - limitBefore, 9);
    const lostFinish = await setup(); modelMode = 'normal'; loseFinish = true; await tools.enablePhoneTools(lostFinish.scope, lostFinish.grant.id, true);
    await assert.rejects(client.runWorkspaceChat(lostFinish.workspace, model, 'Finish acknowledgement lost', new AbortController().signal));
    const finishBefore = modelRequests, createsBeforeRecovery = nativeOps.filter(op => op.operation === 'create').length;
    const finished = await client.runWorkspaceChat(lostFinish.workspace, model, null, new AbortController().signal);
    assert.equal(finished.run.state, 'complete'); assert.equal(modelRequests, finishBefore);
    assert.equal(nativeOps.filter(op => op.operation === 'create').length, createsBeforeRecovery);
    assert.equal(tools.phoneToolRunPending(lostFinish.scope, finished.run.id), false);
    for (const collection of [JSON.stringify([...kv]), JSON.stringify(traces), JSON.stringify(ledger.getUsageLedger()), JSON.stringify(backendRequests)]) {
        assert.ok(!collection.includes(BODY)); assert.ok(!collection.includes(NEW)); assert.ok(!collection.includes('content://PRIVATE_PROVIDER_EXCEPTION'));
    }
    assert.ok(traces.some(item => item.operation === 'create' && item.receiptId));
    assert.ok(ledger.getUsageLedger().some(item => item.reason === 'tool_continuation'));
    console.log('AI scoped phone tools: actual client/proxies/SQLite and OpenAI/Anthropic/Gemini ID loops; work/private binding, default off, old/no bridge, no picker, list-before-read/create, no overwrite/preflight race, read-only schema, no life/network fallback, revocation/cancel, bad location/path/digest, lost-create recovery without replay, bounded rounds, and metadata-only KV/traces/usage/backend passed. Fake Native and models only; no APK/SAF/device validation.');
} finally { child.kill(); }
