// Run against an isolated, patched copy of the pinned public engine. Use only synthetic state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const fixture = process.env.FLOAT_TEST_XINCHAO_SOURCE;
assert.ok(fixture, 'Set FLOAT_TEST_XINCHAO_SOURCE to an isolated, patched src copy with loopback listener');
const serverFile = resolve(fixture, 'server.js');
assert.ok(readFileSync(serverFile, 'utf8').includes("server.listen(config.port, '127.0.0.1'"));
const dir = mkdtempSync(join(tmpdir(), 'float-heart-synthetic-'));
let modelCalls = 0;
const model = createServer((req, res) => {
    modelCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
        JSON.stringify({
            choices: [
                { message: { content: JSON.stringify({ lines: ['合成测试短句一', '合成测试短句二'] }) } },
            ],
        }),
    );
});
await new Promise((done) => model.listen(0, '127.0.0.1', done));
const reserve = createServer();
await new Promise((done) => reserve.listen(0, '127.0.0.1', done));
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
const token = 'SYNTHETIC_TEST_TOKEN_' + randomUUID(),
    url = 'http://127.0.0.1:' + port;
const env = {
    SystemRoot: process.env.SystemRoot || '',
    PATH: process.env.PATH,
    PORT: String(port),
    SERVICE_TOKEN: token,
    MCP_ENABLED: 'true',
    MODEL_ENABLED: 'true',
    MODEL_API_KEY: 'synthetic-only',
    MODEL_BASE_URL: 'http://127.0.0.1:' + model.address().port + '/v1',
    SETTLE_INTERVAL_MINUTES: '1440',
    DRIVE_POOL: 'true',
    PULSE: 'true',
    SHADOW_MODE: 'true',
    BRIDGE_ENABLED: 'false',
    BARK_ENABLED: 'false',
    DASHBOARD_INCLUDE_PRIVATE_TEXT: 'false',
};
for (const name of [
    'STATE_PATH',
    'PERSONALITY_PATH',
    'TRANSITION_JOURNAL_PATH',
    'OAUTH_STATE_PATH',
    'BRIDGE_STATE_PATH',
    'DRIVE_PROMPTS_FILE',
    'DRIVE_PROMPTS_STATE_PATH',
    'DRIVE_POOL_PATH',
    'CALL_STATE_PATH',
    'BOX_STATE_PATH',
    'CABIN_STATE_PATH',
    'OMBRE_HEARTBEAT_FILE',
])
    env[name] = join(dir, name + '.json');
writeFileSync(env.DRIVE_PROMPTS_FILE, JSON.stringify({ hints: { curiosity: '心里冒出一句。再继续想。' } }));
const child = spawn(process.execPath, [serverFile], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
});
let errors = '';
child.stderr.on('data', (b) => (errors += b));
const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => mocks[name] || require(name),
            fetch,
            process,
            URL,
            AbortSignal,
            TextDecoder,
            Date,
            Error,
            Response,
        },
        { filename: path },
    );
    return module.exports;
}
try {
    for (let n = 0; n < 80; n++) {
        if (
            await fetch(url + '/health')
                .then((r) => r.ok)
                .catch(() => false)
        )
            break;
        if (child.exitCode !== null || n === 79)
            throw Error('Synthetic service startup failed: ' + errors.slice(-1000));
        await new Promise((done) => setTimeout(done, 100));
    }
    const common = load('lib/server/shared-memory.ts'),
        source = load('lib/server/xinchao.ts', { './shared-memory': common }),
        types = load('lib/xinchao-inner-types.ts');
    const inner = load('lib/server/xinchao-inner.ts', {
        './shared-memory': common,
        './xinchao': source,
        '../xinchao-inner-types': types,
    });
    const api = inner.createXinchaoInner({
        FLOAT_XINCHAO_URL: url,
        DYNAMIC_MIND_TOKEN: token,
        FLOAT_XINCHAO_ALLOW_HTTP: 'true',
        FLOAT_XINCHAO_REST_CONTRACT: '4.3.0-2abe7fa9',
        FLOAT_XINCHAO_INNER_CONTRACT: 'float-xinchao-inner/v1-2abe7fa9',
    });
    const route = load('app/api/shared-memory/xinchao/inner/route.ts', {
        'next/server': { NextResponse: Response },
        '@/lib/server/shared-memory': {
            ...common,
            sharedMemoryRequestOrigin: () => 'https://fixture.example',
            readSharedMemoryConfig: () => ({}),
            authorizeSharedMemory: (req) => req.headers.get('cookie') === 'test-owner=yes',
        },
        '@/lib/server/xinchao-inner': { createXinchaoInner: () => api },
        '@/lib/xinchao-inner-types': types,
    });
    const routeCall = (body, origin = 'https://fixture.example', cookie = 'test-owner=yes') =>
        route.POST(
            new Request('https://fixture.example/api/shared-memory/xinchao/inner', {
                method: 'POST',
                headers: { origin, cookie },
                body: JSON.stringify(body),
            }),
        );
    assert.equal(
        (await routeCall({ operation: 'read', module: 'state' }, 'https://other.example')).status,
        403,
    );
    assert.equal(
        (await routeCall({ operation: 'read', module: 'state' }, 'https://fixture.example', '')).status,
        401,
    );
    assert.equal(
        (await routeCall({ operation: 'read', module: 'state', url: 'https://other.example' })).status,
        400,
    );
    assert.equal((await routeCall({ operation: 'read', module: 'state' })).status, 200);
    for (const name of types.INNER_MODULES) {
        const doc = await api.read(name);
        assert.equal(doc.module, name);
        assert.ok(!JSON.stringify(doc).includes(token));
    }
    assert.equal(modelCalls, 0);
    let doc = await api.read('state');
    assert.ok(doc.metrics.some((m) => m.key === 'libido'));
    assert.ok(doc.metrics.some((m) => m.key === 'arousal'));
    let revision = doc.controls.revision;
    async function action(input) {
        const id = randomUUID();
        const r = await api.mutate(id, revision, input);
        assert.equal(r.state, 'complete');
        const repeat = await api.mutate(id, revision, input);
        assert.equal(repeat.replayed, true);
        revision++;
        return r;
    }
    const binding = { characterId: 'fixture-role', name: '合成角色', coreHash: 'a'.repeat(64) },
        context = { sessionId: 'fixture-chat', characterId: binding.characterId, coreHash: binding.coreHash };
    await action({ action: 'bind', binding, confirm: true });
    await action({ action: 'letter', content: 'PRIVATE_SYNTHETIC_LOCKED_LETTER', locked: true });
    const letter = (await api.read('cabin')).records[0];
    assert.equal(letter.locked, true);
    const tool = (args) => api.tool({ requestId: randomUUID(), context, args });
    assert.ok(!(await tool({ action: 'cabin_inbox' })).text.includes('PRIVATE_SYNTHETIC_LOCKED_LETTER'));
    await action({ action: 'letter_lock', id: letter.id, locked: false });
    assert.ok((await tool({ action: 'cabin_inbox' })).text.includes('PRIVATE_SYNTHETIC_LOCKED_LETTER'));
    await tool({ action: 'cabin_note', content: 'SYNTHETIC_REPLY' });
    assert.ok((await api.read('cabin')).records.some((r) => r.text === 'SYNTHETIC_REPLY'));
    await tool({ action: 'box_put', text: 'SYNTHETIC_BOX_ONLY' });
    assert.ok((await tool({ action: 'box_list' })).text.length > 0);
    assert.ok(!JSON.stringify(await api.read('blackbox')).includes('SYNTHETIC_BOX_ONLY'));
    await assert.rejects(
        api.tool({
            requestId: randomUUID(),
            context: { ...context, coreHash: 'b'.repeat(64) },
            args: { action: 'box_list' },
        }),
    );
    await action({ action: 'body_offset', hr: 12, breath: 2, minutes: 4 });
    assert.ok((await api.read('body')).metrics.find((m) => m.key === 'hr').value > 0);
    await action({ action: 'satisfy', drive: 'curiosity' });
    assert.ok((await api.read('timeline')).records.some((r) => r.title === 'satisfy'));
    await action({ action: 'anchor_add', label: '合成底线', description: '临时测试', confirm: true });
    assert.ok((await api.read('core')).records.some((r) => r.title === '合成底线'));
    assert.equal(modelCalls, 0);
    await action({ action: 'refill', drive: 'curiosity', confirm: true });
    assert.ok(modelCalls > 0);
    assert.ok((await api.read('jars')).metrics.find((m) => m.key === 'curiosity').value > 0);
    await action({ action: 'controls', generation: 'paused', jarGeneration: 'paused', confirm: true });
    const count = modelCalls;
    await assert.rejects(
        api.mutate(randomUUID(), revision, { action: 'refill', drive: 'curiosity', confirm: true }),
    );
    assert.equal(modelCalls, count);
    console.log(
        'Actual 4.3.0 engine + Float HTTP adapter: eight modules, fixed core, upstream bearer, locked/unlocked inbox, native MCP box, anchors, body, drives, timeline, durable dedupe, explicit refill and paused generation passed. All content and model responses synthetic.',
    );
} finally {
    child.kill();
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
}
