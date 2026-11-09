import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
export function load(relative, mocks = {}, env = {}) {
    const module = { exports: {} };
    const compiled = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(compiled, { module, exports: module.exports, require: n => mocks[n] ?? require(n), process: { env },
        URL, Request, Response, AbortSignal, TextDecoder, Date, fetch, console });
    return module.exports;
}
const common = load('../lib/server/shared-memory.ts');
const env = { FLOAT_XINCHAO_URL: 'http://127.0.0.1', DYNAMIC_MIND_TOKEN: 'synthetic-server-only-'.repeat(3), FLOAT_XINCHAO_ALLOW_HTTP: 'true', FLOAT_XINCHAO_REST_CONTRACT: '4.3.0-2abe7fa9' };
const adapter = load('../lib/server/xinchao.ts', { './shared-memory': common }, env);
assert.throws(() => adapter.readXinchaoConfig({}), /尚未配置/);
assert.throws(() => adapter.readXinchaoConfig({ ...env, FLOAT_XINCHAO_REST_CONTRACT: '' }), /尚未确认/);
for (const base of ['http://public.example', 'https://u:p@host', 'https://host/path', 'https://host?q=x', 'https://host#x']) {
    assert.throws(() => adapter.readXinchaoConfig({ ...env, FLOAT_XINCHAO_URL: base, FLOAT_XINCHAO_ALLOW_HTTP: 'false' }), /无效/);
}
const at = '2026-11-09T04:00:00.000Z';
const state = { schemaVersion: 10, revision: 8, consciousness: 'awake', lastSettledAt: at, drives: { curiosity: .4, boredom: .1, duty: .3, reflection: .2, grieve: 0, anger: 0, libido: .8 }, secretRawState: 'DO_NOT_PROJECT', thoughtPool: { private: 'DO_NOT_PROJECT' } };
const now = { ok: true, text: '【心潮·此刻】\n好奇与平静。', revision: 9, generatedAt: at };
let scenario = 'valid'; const calls = [];
const fixture = createServer((req, res) => {
    calls.push({ path: req.url, method: req.method });
    assert.equal(req.headers.authorization, 'Bearer ' + env.DYNAMIC_MIND_TOKEN);
    res.setHeader('Content-Type', 'application/json');
    if (scenario === 'auth') { res.writeHead(401); res.end(JSON.stringify({ error: env.DYNAMIC_MIND_TOKEN })); return; }
    if (scenario === 'redirect') { res.writeHead(302, { Location: 'http://untrusted.invalid' }); res.end(); return; }
    if (scenario === 'html') { res.setHeader('Content-Type', 'text/html'); res.end('<html>DO_NOT_PROJECT</html>'); return; }
    if (req.url === '/health') { res.end(JSON.stringify({ ok: true, system: 'xinchao-dynamic-mind', version: scenario === 'version' ? '4.4.0' : '4.3.0' })); return; }
    if (req.url === '/v1/state') { res.end(JSON.stringify(scenario === 'bad-state' ? { ...state, drives: { curiosity: 7 } } : state)); return; }
    if (req.url === '/v1/now') {
        res.end(JSON.stringify(scenario === 'empty-now' ? { ...now, ok: false, text: '', reason: 'render_guard' } : scenario === 'bad-now' ? { ...now, text: '' } : now)); return;
    }
    res.writeHead(404); res.end('{}');
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
env.FLOAT_XINCHAO_URL = 'http://127.0.0.1:' + fixture.address().port;
try {
    const config = adapter.readXinchaoConfig(env);
    const snapshot = await adapter.readXinchaoSnapshot(config);
    assert.equal(snapshot.revision, 8); assert.equal(snapshot.now.revision, 9); assert.equal(snapshot.drives.length, 6);
    assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_PROJECT')); assert.ok(!JSON.stringify(snapshot).includes('libido'));
    assert.ok(!JSON.stringify(snapshot).includes(env.DYNAMIC_MIND_TOKEN));
    assert.deepEqual(calls.map(v => v.path).sort(), ['/health', '/v1/now', '/v1/state']); assert.ok(calls.every(v => v.method === 'GET'));
    for (const kind of ['version', 'auth', 'redirect', 'html', 'bad-state', 'bad-now']) {
        scenario = kind; const start = calls.length;
        await assert.rejects(adapter.readXinchaoSnapshot(config), error => error instanceof common.SharedMemoryError && !error.message.includes(env.DYNAMIC_MIND_TOKEN));
        if (['version', 'auth', 'redirect', 'html'].includes(kind)) assert.equal(calls.length - start, 1);
    }
    scenario = 'empty-now'; assert.equal((await adapter.readXinchaoSnapshot(config)).now.available, false); scenario = 'valid';
    await assert.rejects(adapter.readXinchaoSnapshot(config, undefined, async () => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })), error => error.code === 'xinchao_size');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(adapter.readXinchaoSnapshot(config, aborted.signal), error => error.code === 'xinchao_unreachable');
    const owner = { baseUrl: 'http://ombre.invalid', password: 'synthetic', accessToken: 'a'.repeat(64) };
    const routeEnv = { FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN: 'https://float.example' };
    const shared = load('../lib/server/shared-memory.ts', {}, routeEnv);
    const route = load('../app/api/shared-memory/xinchao/route.ts', {
        'next/server': { NextResponse: { json: (data, options) => Response.json(data, options) } },
        '@/lib/server/shared-memory': { ...shared, readSharedMemoryConfig: () => owner },
        '@/lib/server/xinchao': { ...adapter, readXinchaoConfig: () => config },
    });
    const make = (headers = {}, body) => new Request('http://internal:3000/api/shared-memory/xinchao', { method: 'POST', headers: { origin: 'https://float.example', 'x-float-memory-access-token': owner.accessToken, ...headers }, ...(body === undefined ? {} : { body }) });
    let result = await route.POST(make()); assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.ok(!JSON.stringify(await result.json()).includes(env.DYNAMIC_MIND_TOKEN));
    const baseline = calls.length;
    assert.equal((await route.POST(make({ origin: 'https://evil.invalid', 'x-forwarded-host': 'float.example' }))).status, 403);
    assert.equal((await route.POST(make({ 'sec-fetch-site': 'cross-site' }))).status, 403);
    assert.equal((await route.POST(make({ 'x-float-memory-access-token': '' }))).status, 401);
    assert.equal((await route.POST(make({}, JSON.stringify({ path: '/v1/body', url: 'http://arbitrary.invalid' })))).status, 400);
    assert.equal(calls.length, baseline);
    const cookie = shared.sharedMemorySessionCookie(make(), owner).split(';')[0];
    assert.equal((await route.POST(make({ 'x-float-memory-access-token': '', cookie }))).status, 200);
    const nowRoute = load('../app/api/shared-memory/xinchao/now/route.ts', {
        'next/server': { NextResponse: { json: (data, options) => Response.json(data, options) } },
        '@/lib/server/shared-memory': { ...shared, readSharedMemoryConfig: () => owner },
        '@/lib/server/xinchao': { ...adapter, readXinchaoConfig: () => config },
    });
    const beforeNow = calls.length;
    const nowResult = await nowRoute.POST(make()); assert.equal(nowResult.status, 200);
    assert.equal((await nowResult.json()).protocol, 'float-xinchao-now/v1');
    assert.deepEqual(calls.slice(beforeNow).map(call => call.path), ['/health', '/v1/now']);
    assert.equal((await nowRoute.POST(make({ origin: 'https://evil.invalid' }))).status, 403);
    assert.equal((await nowRoute.POST(make({}, '{}'))).status, 400);
    const cache = new Map();
    const client = load('../lib/xinchao-client.ts', { './kv-db': { kvGet: k => cache.get(k), kvSet: (k, v) => cache.set(k, v), registerKvMigration() {} } });
    assert.equal(client.xinchaoViewEnabled(), false); client.setXinchaoViewEnabled(true); assert.equal(client.xinchaoViewEnabled(), true); client.setXinchaoViewEnabled(false);
    assert.deepEqual([...cache.values()], ['disabled']);
    const iconSource = readFileSync(new URL('../lib/desktop-config.ts', import.meta.url), 'utf8');
    assert.match(iconSource, /PAGE_4_DEFAULT[^\n]*"xinchao"/);
    const component = readFileSync(new URL('../components/xinchao/xinchao-app.tsx', import.meta.url), 'utf8');
    assert.match(component, /checked=\{false\} disabled/); assert.ok(!/setInterval|EventSource|runChat|writeMemory/.test(component));
    for (const path of ['../lib/workspace-client.ts', '../lib/llm-prompt-assembler.ts']) assert.ok(!readFileSync(new URL(path, import.meta.url), 'utf8').includes('xinchao'));
    console.log('Xinchao 4.3.0 read-only: real local HTTP, strict version/config, fixed GETs, projection, hidden credentials, owner cookie, origin/body rejection and off-by-default scope passed. No VPS/model accessed.');
} finally { const done = new Promise(r => fixture.close(r)); fixture.closeAllConnections(); await done; }
