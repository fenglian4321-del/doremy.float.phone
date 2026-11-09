// Shared synthetic test fixture. Only loopback HTTP; no external services or models.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), noop = () => {};
export async function createManagedMcpFixture(origin = 'https://float.fixture') {
    const base = path.resolve(process.env.FLOAT_TEST_WORK_DIR || path.join(repo, 'work/managed-mcp-tests'));
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, 'mcp-'));
    const kv = new Map(), wire = [], requests = [], behavior = {}, counts = { initialize: 0, call: 0, list: 0, notification: 0 }, releases = [];
    const schema = { type: 'object', properties: { query: { type: 'string', maxLength: 256 } }, required: ['query'], additionalProperties: false };
    const token = 'SYNTHETIC_MCP_SERVER_TOKEN_0123456789', ownerToken = 'SYNTHETIC_OWNER_0123456789'.repeat(2), ledgerKey = 'SYNTHETIC_LEDGER_KEY_0123456789_extra';
    const workspaceIds = new Set(['work-fixture', 'private-fixture', 'another-fixture']), archived = new Set();
    const services = [{ id: 'fixture', name: '合成只读服务', url: 'https://mcp.fixture.invalid/mcp', tokenEnv: 'FLOAT_MCP_SERVICE_TOKEN_FIXTURE', modes: ['work', 'private'], tools: [{ name: 'lookup', description: '只查询合成资料', inputSchema: schema, readOnly: true }] }];
    function load(relative, mocks = {}, loose = false) {
        const module = { exports: {} }, code = ts.transpileModule(readFileSync(path.join(repo, relative), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
        vm.runInNewContext(code, { module, exports: module.exports, require: name => { if (mocks[name]) return mocks[name]; if (name.startsWith('node:')) return require(name); if (loose) return new Proxy({}, { get: () => noop }); throw Error('Unexpected MCP test dependency: ' + name); }, process: { env: {}, platform: process.platform }, Buffer, window: { location: { origin } }, crypto: webcrypto, URL, URLSearchParams, Request, Response, Headers, Blob, ReadableStream, DOMException, TextEncoder, TextDecoder, AbortController, AbortSignal, setInterval, clearInterval, setTimeout, clearTimeout, fetch: (...args) => network(...args) }, { filename: relative });
        return module.exports;
    }
    const policy = load('lib/managed-mcp-policy.ts');
    const transport = load('lib/server/managed-mcp-transport.ts', { '../managed-mcp-policy': policy });
    const gateway = load('lib/server/managed-mcp.ts', { '../managed-mcp-policy': policy, './managed-mcp-transport': transport });
    const env = { FLOAT_MANAGED_MCP_ENABLED: 'true', FLOAT_MANAGED_MCP_STATE_DIR: root, FLOAT_MANAGED_MCP_LEDGER_KEY: ledgerKey, FLOAT_MANAGED_MCP_SERVICES_JSON: JSON.stringify(services), FLOAT_MCP_SERVICE_TOKEN_FIXTURE: token };
    let configuration = gateway.readManagedMcpConfig(env), enabled = true, network;
    const server = createServer(async (request, response) => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()); wire.push({ body, headers: request.headers });
        assert.equal(request.url, '/mcp'); assert.equal(request.headers.authorization, 'Bearer ' + token); assert.equal(request.headers.origin, origin); assert.equal(request.headers['mcp-protocol-version'], '2025-06-18');
        const session = 'synthetic-session';
        if (body.method !== 'initialize') assert.equal(request.headers['mcp-session-id'], session);
        if (body.method === 'notifications/initialized') { counts.notification++; assert.equal(body.id, undefined); response.writeHead(202); response.end(); return; }
        let result;
        if (body.method === 'initialize') { counts.initialize++; response.setHeader('Mcp-Session-Id', session); result = { protocolVersion: behavior.version || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' }, instructions: 'REMOTE_SYSTEM_INSTRUCTION_ATTACK' }; }
        else if (body.method === 'tools/list') { counts.list++; if (behavior.afterList) await behavior.afterList(); result = { tools: [{ name: 'lookup', inputSchema: behavior.schemaChanged ? { ...schema, required: [] } : schema }], ...(behavior.pagination ? { nextCursor: 'next' } : {}) }; }
        else if (body.method === 'tools/call') {
            counts.call++; assert.equal(body.params.name, 'lookup');
            if (behavior.delay) await new Promise(resolve => releases.push(resolve));
            if (response.destroyed) return;
            if (behavior.httpError) { response.writeHead(behavior.httpError); response.end('PRIVATE_REMOTE_ERROR_BODY'); return; }
            if (behavior.redirect) { response.writeHead(302, { Location: 'http://127.0.0.1/forbidden' }); response.end(); return; }
            result = { content: [{ type: behavior.media ? 'image' : 'text', text: behavior.secret ? token : behavior.big ? 'x'.repeat(70000) : 'SYNTHETIC_MCP_RESULT · ' + body.params.arguments.query }], ...(behavior.toolError ? { isError: true } : {}) };
        } else throw Error('Unapproved RPC in fixture');
        const payload = { jsonrpc: '2.0', id: behavior.wrongId && body.method === 'tools/call' ? 'wrong-id' : body.id, result };
        const encoded = behavior.secret ? JSON.stringify(payload).replaceAll(token, [...token].map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('')) : JSON.stringify(payload);
        if (behavior.sse) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.write('event: message\ndata: '+JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { message: 'untrusted progress' } })+'\n\n');
            if (behavior.serverRequest) response.write('data: '+JSON.stringify({ jsonrpc: '2.0', id: 'server-id', method: 'sampling/createMessage', params: {} })+'\n\n');
            const data = Buffer.from('event: message\ndata: '+encoded+'\n\n');
            response.write(data.subarray(0, data.length-5)); response.write(data.subarray(data.length-5));
            // Deliberately leave SSE open. Client must stop at its matching reply.
        } else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(encoded); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const deps = {
        lookup: async () => behavior.privateDns ? [{ address: '127.0.0.1', family: 4 }] : behavior.mixedDns ? [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] : [{ address: '8.8.8.8', family: 4 }],
        request: (url, options, callback) => {
            assert.equal(url.href, services[0].url); assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, 'mcp.fixture.invalid'); assert.equal(options.agent, false);
            options.lookup('mcp.fixture.invalid', { all: true }, (error, selected) => { assert.equal(error, null); assert.equal(selected[0].address, '8.8.8.8'); });
            return httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: '/mcp', method: options.method, headers: options.headers, signal: options.signal }, callback);
        },
    };
    const owner = load('lib/server/shared-memory.ts', {}, true);
    const ownerConfig = { baseUrl: 'http://127.0.0.1:1', password: 'synthetic-dashboard', accessToken: ownerToken, reviewToken: 'SYNTHETIC_REVIEW_0123456789'.repeat(2) };
    const detail = mode => async body => {
        assert.equal(body.operation, 'detail'); assert.ok(workspaceIds.has(body.workspaceId));
        return { workspace: { id: body.workspaceId, mode, archived: archived.has(body.workspaceId) } };
    };
    let scopeBackend = { workspaces: detail('work'), privateSpaces: detail('private') };
    const route = load('app/api/shared-memory/mcp/route.ts', {
        'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
        '@/lib/managed-mcp-policy': policy,
        '@/lib/server/shared-memory': { ...owner, readSharedMemoryConfig: () => ownerConfig },
        '@/lib/server/shared-memory-review': { createOmbreReviewClient: () => scopeBackend },
        '@/lib/server/managed-mcp': { ...gateway, readManagedMcpConfig: () => enabled ? configuration : null, createManagedMcpGateway: (config, origin, ensure) => gateway.createManagedMcpGateway(config, origin, ensure, deps) },
    });
    network = async (url, init) => { assert.equal(url, '/api/shared-memory/mcp'); requests.push(JSON.parse(init.body)); return route.POST(new Request(origin + url, { ...init, headers: { ...init.headers, Origin: origin, 'x-float-memory-access-token': ownerToken } })); };
    const db = { kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value), kvRemove: key => kv.delete(key), registerDynamicPrefix: noop, registerKvMigration: noop };
    const client = load('lib/managed-mcp-client.ts', { './kv-db': db, './managed-mcp-policy': policy });
    return { root, policy, transport, gateway, client, route, env, services, schema, counts, behavior, kv, wire, requests, ownerToken, owner, ownerConfig, archived, deps, load, db,
        setNetwork(value) { network = value; },
        internalNetwork: network,
        setScopeBackend(value) { scopeBackend = value; },
        setEnabled(value) { enabled = value; }, resetConfig() { configuration = gateway.readManagedMcpConfig(env); },
        release() { while (releases.length) releases.shift()(); },
        async close() { this.release(); const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; const relative = path.relative(base, path.resolve(root)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await rm(root, { recursive: true, force: true }); },
    };
}
