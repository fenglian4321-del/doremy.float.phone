// Actual browser runtime/provider adapters + owner proxies + synthetic SQLite backend.
// Native accessibility and every model response are synthetic. No device/provider/account access.
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
const phone = load('../lib/scoped-device-ui.ts', { './kv-db': db });
const tools = load('../lib/phone-device-tools.ts', { './kv-db': db, './scoped-device-ui': phone });
const tokens = load('../lib/token-usage.ts'), ledger = load('../lib/usage-ledger.ts', { './kv-db': db });
const usage = load('../lib/usage-fetch.ts', { './usage-ledger': ledger, './token-usage': tokens });
const helpers = load('../lib/api-helpers.ts', { './usage-fetch': usage, './token-usage': tokens }, false);
const adapter = load('../lib/llm-provider-adapter.ts', { './api-helpers': helpers, './generation-parameters': { resolveEnabledGenerationParameters: () => new Set() }, './token-usage': tokens });
const http = load('../lib/llm-http.ts', { './usage-fetch': usage });
const budget = load('../lib/consolidation-budget.ts', { './token-counter': load('../lib/token-counter.ts') });
const client = load('../lib/workspace-client.ts', { './kv-db': db, './phone-file-tools': { getPhoneToolSession:()=>null, phoneToolRunPending:()=>false, clearPhoneToolRun:noop, disablePhoneTools:noop }, './llm-provider-adapter': adapter, './llm-http': http, './consolidation-budget': budget, './phone-device-tools':tools,'./managed-mcp-session': { getManagedMcpSession: () => null, managedMcpSessionPreparing: () => false, managedMcpRunPending: () => false, clearManagedMcpRun: noop, disableManagedMcpSession: noop } });
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
const TASK = 'Find the synthetic note and type a new title', PRIVATE = 'SYNTHETIC_UI_PRIVATE_BODY';
const sha = text => createHash('sha256').update(text).digest('hex');
const wire = value => JSON.stringify({ protocol: 'float-shell-device-ui/v1', location: 'android_device', ...value });
const grants = new Map(), receipts = new Map(), nativeOps = [], backendRequests = [], traces = [];
let behavior = '', modelMode = 'normal', modelRequests = 0, stopDuringModel;
const snapshot = grant => ({ snapshotId: webcrypto.randomUUID(), grantId: grant.id, appLabel: grant.label, at: Date.now(), untrustedData: true, limited: false, nodes: [{ id: 'n0', text: PRIVATE, description: '', role: 'EditText', clickable: true, editable: true, enabled: true, sensitive: false, textTruncated: false, bounds: [0, 0, 100, 100] }] });
const native = {
    getDeviceUiCapabilities: () => wire({ state: 'complete', available: true }),
    requestDeviceUiGrant: (_scope, id) => { nativeOps.push({ operation: 'grant', id }); return behavior === 'malformed-grant' ? '{' : wire({ state: 'failed', code: 'review_declined' }); },
    getDeviceUiGrant: (scope, id) => { const grant = grants.get(id); return grant && JSON.stringify(grant.scope) === scope ? wire({ state: 'complete', grant }) : wire({ state: 'failed', code: 'grant_expired' }); },
    activateDeviceUiGrant: (scope, id, runId, claim, digest) => { const grant = grants.get(id); assert.equal(JSON.stringify(grant.scope), scope); assert.equal(grant.taskDigest, digest); grant.runId = runId; grant.claim = claim; return wire({ state: 'complete', grant }); },
    submitDeviceUi: raw => {
        const body = JSON.parse(raw), grant = grants.get(body.grantId); nativeOps.push(body);
        assert.ok(grant); assert.equal(JSON.stringify(grant.scope), JSON.stringify(body.scope)); assert.ok(grant.runId);
        if (behavior === 'stale' && body.operation !== 'observe') return wire({ state: 'failed', code: 'stale_snapshot' });
        const result = { state: 'complete', requestId: body.requestId, operation: body.operation, snapshot: snapshot(grant) };
        if (body.operation !== 'observe') {
            assert.ok(grant.allowActions);
            result.receipt = { requestId: body.requestId, operation: body.operation, state: 'requested', inputVerified: body.operation === 'input', uiChanged: true };
            receipts.set(body.requestId, { ...result, snapshot: undefined });
            if (behavior === 'lost-action') throw Error('PRIVATE_NATIVE_EXCEPTION');
        }
        if (behavior === 'wrong-location') return JSON.stringify({ ...result, protocol: 'float-shell-device-ui/v1', location: 'vps' });
        return wire(result);
    },
    getDeviceUiResult: () => { throw Error('No pending fixture result'); },
    getDeviceUiReceipt: (_scope, id) => { nativeOps.push({ operation: 'receipt', id }); return wire(receipts.get(id) || { state: 'failed', code: 'request_missing' }); },
    cancelDeviceUi: (_scope, id) => { nativeOps.push({ operation: 'cancel', id }); return wire({ state: 'failed', code: 'cancelled' }); },
    revokeDeviceUiGrant: (_scope, id) => { nativeOps.push({ operation: 'revoke', id }); grants.delete(id); return wire({ state: 'complete' }); },
};
const model = { id: 'device-api', provider: 'Custom', baseUrl: 'https://selected-device.fixture/v1', apiKey: 'SYNTHETIC_KEY', defaultModel: 'synthetic-model', enableNativeTools: true, contextWindowTokens: 64000 };
const resultsFrom = (body, protocol) => protocol === 'anthropic' ? body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result').map(part => JSON.parse(part.content)) : protocol === 'gemini' ? body.contents.flatMap(message => message.parts).filter(part => part.functionResponse).map(part => part.functionResponse.response) : body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
network = async (url, init) => {
    if (url.startsWith('/api/shared-memory/')) {
        backendRequests.push(JSON.parse(init.body));
        return routes[url.endsWith('/private-space') ? 'private-space' : 'workspaces'].POST(new Request('https://float.fixture' + url, { ...init, headers: { ...init.headers, Origin: 'https://float.fixture', 'x-float-memory-access-token': config.accessToken } }));
    }
    if (url.startsWith(config.baseUrl + '/float-memory/v2/')) return fetch(url, init);
    const hostname = new URL(url).hostname;
    assert.ok(['selected-device.fixture', 'api.anthropic.com', 'generativelanguage.googleapis.com'].includes(hostname));
    modelRequests++;
    const protocol = hostname === 'api.anthropic.com' ? 'anthropic' : hostname === 'generativelanguage.googleapis.com' ? 'gemini' : 'openai';
    const body = JSON.parse(init.body), results = resultsFrom(body, protocol);
    const declarations = protocol === 'anthropic' ? body.tools : protocol === 'gemini' ? body.tools?.flatMap(tool => tool.functionDeclarations || []) : body.tools?.map(tool => tool.function);
    assert.ok(!init.body.includes('PRIVATE_LIFE_SENTINEL'));
    if (modelMode === 'plain') assert.ok(!declarations?.some(tool => tool.name.startsWith('phone_')));
    else {
        assert.equal(declarations.length, modelMode === 'readonly' ? 1 : 4);
        for (const tool of declarations) {
            assert.ok(tool.name.startsWith('phone_'));
            const schema = tool.parameters || tool.input_schema;
            assert.ok(!Object.keys(schema.properties).some(key => ['scope', 'grantId', 'claim', 'runId', 'packageName'].includes(key)));
        }
    }
    for (const raw of results) { const wrapped = raw.type ? raw : raw.result; const result = typeof wrapped === 'string' ? JSON.parse(wrapped) : wrapped; assert.equal(result.type, 'phone_device_ui'); assert.equal(result.location, 'android_device'); assert.equal(result.businessSuccessVerified, false); assert.equal(result.snapshot.grantId, undefined); }
    const last = results.at(-1), wrapped = last?.type ? last : last?.result; const value = typeof wrapped === 'string' ? JSON.parse(wrapped) : wrapped;
    const done = modelMode === 'plain' || (modelMode === 'readonly' ? results.length >= 1 : results.length >= 2);
    let calls = done ? [] : [results.length === 0 ? { id: 'observe', name: 'phone_observe_ui', args: {} } : { id: 'input', name: 'phone_input_ui', args: { snapshotId: value.snapshot.snapshotId, nodeId: 'n0', text: 'New synthetic title' } }];
    if (modelMode === 'forbidden') calls = [{ id: 'forbidden', name: 'workspace_write_file', args: {} }];
    if (modelMode === 'extra-scope') calls = [{ id: 'bad-scope', name: 'phone_observe_ui', args: { scope: 'life' } }];
    if (stopDuringModel) { stopDuringModel(); stopDuringModel = undefined; }
    const reply = done ? 'Synthetic task checked using device receipts.' : '';
    if (protocol === 'anthropic') return Response.json({ content: reply ? [{ type: 'text', text: reply }] : calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })), usage: { input_tokens: 10, output_tokens: 5 } });
    if (protocol === 'gemini') return Response.json({ candidates: [{ content: { parts: reply ? [{ text: reply }] : calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: call.args }, thoughtSignature: 'synthetic-signature' })) } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    return Response.json({ choices: [{ message: { content: reply, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
};
const create = async (kind = 'work', allowActions = true) => {
    const workspace = (await client.spaceCall(kind, 'create', { title: 'Synthetic UI', clientKey: webcrypto.randomUUID() })).workspace;
    const scope = { mode: kind, workspaceId: workspace.id }, grant = { id: webcrypto.randomUUID(), label: 'Synthetic application', taskDigest: sha(TASK), allowActions, expires: Date.now() + 600000, scope };
    grants.set(grant.id, grant); return { workspace, scope, grant };
};
const lease = async (fixture, claim, runId, extra = {}, headers = {}) => routes[fixture.scope.mode === 'work' ? 'workspaces' : 'private-space'].POST(new Request('https://float.fixture/api/shared-memory/workspaces', { method: 'POST', headers: { Origin: 'https://float.fixture', 'x-float-memory-access-token': config.accessToken, 'x-float-space-external-tools': 'v1', ...headers }, body: JSON.stringify({ operation: 'phone_lease', workspaceId: fixture.workspace.id, runId, claim, ...extra }) }));
try {
    assert.equal(phone.deviceUiAvailability().available, false);
    const absent = await create(); modelMode = 'plain';
    await client.runWorkspaceChat(absent.workspace, model, TASK, new AbortController().signal);
    assert.equal(nativeOps.length, 0);
    window.AndroidShell = native;
    const off = await create(); await client.runWorkspaceChat(off.workspace, model, TASK, new AbortController().signal); assert.equal(nativeOps.length, 0);
    behavior = 'malformed-grant'; await assert.rejects(phone.requestDeviceUiGrant(off.scope, false, TASK)); assert.equal(nativeOps.at(-1).operation, 'cancel'); behavior = '';
    for (const kind of ['work', 'private']) for (const provider of ['Custom', 'Anthropic', 'Google']) {
        const fixture = await create(kind); modelMode = 'normal'; tools.enablePhoneDeviceTools(fixture.scope, fixture.grant);
        const before = modelRequests, requests = backendRequests.length;
        const result = await client.runWorkspaceChat(fixture.workspace, { ...model, provider, baseUrl: provider === 'Custom' ? model.baseUrl : undefined }, TASK, new AbortController().signal, undefined, kind, [], undefined, undefined, item => traces.push(item));
        assert.equal(result.run.state, 'complete'); assert.equal(modelRequests - before, 3); assert.equal(tools.getPhoneDeviceSession(fixture.scope), null); assert.equal(grants.has(fixture.grant.id), false);
        assert.ok(!JSON.stringify(backendRequests.slice(requests)).includes(PRIVATE)); assert.ok(!backendRequests.slice(requests).some(body => ['turn', 'tool'].includes(body.operation)));
        assert.ok(!JSON.stringify(result.workspace).includes(PRIVATE));
    }
    const readonly = await create('private', false); modelMode = 'readonly'; tools.enablePhoneDeviceTools(readonly.scope, readonly.grant); const beforeRead = nativeOps.length;
    await client.runWorkspaceChat(readonly.workspace, model, TASK, new AbortController().signal, undefined, 'private'); assert.equal(nativeOps.slice(beforeRead).filter(op => op.operation === 'input').length, 0);
    const mismatch = await create(); tools.enablePhoneDeviceTools(mismatch.scope, mismatch.grant); const beforeMismatch = modelRequests;
    await assert.rejects(client.runWorkspaceChat(mismatch.workspace, model, 'Different task', new AbortController().signal)); assert.equal(modelRequests, beforeMismatch);
    for (const failure of ['forbidden', 'extra-scope', 'stale', 'wrong-location', 'lost-action', 'stop']) {
        const fixture = await create(); modelMode = ['forbidden', 'extra-scope'].includes(failure) ? failure : 'normal'; behavior = failure; tools.enablePhoneDeviceTools(fixture.scope, fixture.grant);
        if (failure === 'stop') stopDuringModel = () => tools.disablePhoneDeviceTools(fixture.scope);
        const before = modelRequests, actions = nativeOps.filter(op => op.operation === 'input').length;
        await assert.rejects(client.runWorkspaceChat(fixture.workspace, model, TASK, new AbortController().signal), error => !error.message.includes('PRIVATE_NATIVE_EXCEPTION'));
        assert.ok(modelRequests - before <= 2);
        assert.equal(nativeOps.filter(op => op.operation === 'input').length - actions, ['stale', 'lost-action'].includes(failure) ? 1 : 0);
        const detail = await client.spaceCall('work', 'detail', { workspaceId: fixture.workspace.id }); const beforeResume = modelRequests;
        await assert.rejects(client.runWorkspaceChat(detail.workspace, model, null, new AbortController().signal)); assert.equal(modelRequests, beforeResume);
        if (failure === 'lost-action') { const beforeReceipt = nativeOps.length; const receipt = phone.deviceUiReceipt(fixture.scope); assert.equal(receipt.receipt.inputVerified, true); assert.deepEqual(nativeOps.slice(beforeReceipt).map(op => op.operation), ['receipt']); }
        behavior = '';
    }
    for (const kind of ['work', 'private']) {
        const fixture = await create(kind), claim = webcrypto.randomUUID();
        const begun = await client.spaceCall(kind, 'begin', { workspaceId: fixture.workspace.id, version: fixture.workspace.version, clientKey: webcrypto.randomUUID(), claim, content: TASK, model: model.defaultModel, apiFingerprint: await client.workspaceApiFingerprint(model), externalMode: 'phone' });
        const accepted = await lease(fixture, claim, begun.run.id); assert.equal(accepted.status, 200);
        const body = await accepted.json(); assert.equal(body.taskDigest, sha(TASK)); assert.equal(body.scope.mode, kind); assert.ok(!JSON.stringify(body).includes(TASK)); assert.ok(!JSON.stringify(body).includes(claim));
        assert.equal((await lease(fixture, 'wrong', begun.run.id)).status, 409);
        assert.equal((await lease(fixture, claim, begun.run.id, { scope: 'life' })).status, 400);
        assert.equal((await lease(fixture, claim, begun.run.id, { _externalClient: 'v1' }, { 'x-float-space-external-tools': '' })).status, 400);
        assert.equal((await lease(fixture, claim, begun.run.id, {}, { Origin: 'https://other.fixture' })).status, 403);
        await client.spaceCall(kind, 'cancel', { workspaceId: fixture.workspace.id, runId: begun.run.id, claim }); assert.equal((await lease(fixture, claim, begun.run.id)).status, 409);
    }
    assert.ok(traces.some(item => item.operation === 'input' && item.verified)); assert.ok(!JSON.stringify(traces).includes(PRIVATE));
    assert.ok(![...kv.values()].some(value => value.includes(PRIVATE) || value.includes('New synthetic title')));
    console.log('Device UI: actual 3-provider x 2-space loop, task binding, read-only, owner leases, cancellation, no replay, redaction; native interaction is synthetic.');
} finally { child.kill(); }
