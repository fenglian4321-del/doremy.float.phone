import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const kv = new Map();
const modules = new Map();
const context = vm.createContext({ Response, Request, Headers, ReadableStream, TextDecoder, TextEncoder, AbortController, AbortSignal, Event, crypto, URL, Date, console,
    window: new EventTarget(), setTimeout, clearTimeout });
function load(name) {
    if (name === './kv-db') return { kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value), kvRemove: key => kv.delete(key), registerKvMigration() {} };
    if (modules.has(name)) return modules.get(name);
    const source = ts.transpileModule(readFileSync(new URL('../lib/' + name.replace('./', '') + '.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    const run = vm.runInContext('(function(require,module,exports){' + source + '\n})', context);
    run(load, module, module.exports); modules.set(name, module.exports); return module.exports;
}
const ledger = load('./usage-ledger');
const { fetchWithUsage, createUsageCollector } = load('./usage-fetch');
const metadata = { provider: 'Synthetic', model: 'fixture-model', configId: 'fixture-config', source: 'chat', scopeId: 'synthetic-turn', apiKey: 'SECRET_API_KEY', messages: 'PRIVATE_PROMPT' };
const encoded = text => new TextEncoder().encode(text);
let response = await fetchWithUsage('https://fixture.invalid/?key=SECRET_URL', { headers: { Authorization: 'SECRET_AUTH' } }, metadata,
    async () => new Response(JSON.stringify({ choices: [{ message: { content: 'PRIVATE_REPLY' } }], usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, prompt_tokens_details: { cached_tokens: 80 } } })));
assert.equal(ledger.getUsageLedger()[0].status, 'pending');
await response.json();
let rows = ledger.getUsageLedger(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'completed'); assert.equal(rows[0].usage.total_tokens, 125);
const sse = [
    'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 0 } } }),
    'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } }),
    'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 3 } }), 'data: [DONE]',
].join('\r\n\r\n') + '\r\n\r\n';
response = await fetchWithUsage('https://fixture.invalid', {}, { ...metadata, source: 'background' }, async () => new Response(new ReadableStream({ start(controller) {
    const bytes = encoded(sse); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
} }), { headers: { 'Content-Type': 'text/event-stream' } }));
assert.equal(await response.text(), sse, 'Usage collection must not modify stream bytes');
rows = ledger.getUsageLedger(); assert.equal(rows[1].usage.prompt_tokens, 95); assert.equal(rows[1].usage.completion_tokens, 3); assert.equal(rows[1].usage.cached_tokens, 80); assert.equal(rows[1].usage.cache_creation_tokens, 5); assert.equal(rows[1].usage.total_tokens, undefined);
await assert.rejects(fetchWithUsage('https://fixture.invalid', {}, metadata, async () => { throw Error('SECRET_NETWORK_ERROR'); }));
assert.equal(ledger.getUsageLedger().at(-1).status, 'error');
response = await fetchWithUsage('https://fixture.invalid', {}, metadata, async () => new Response('SECRET_ERROR_BODY', { status: 429 })); await response.text();
assert.equal(ledger.getUsageLedger().at(-1).httpStatus, 429); assert.equal(ledger.getUsageLedger().at(-1).usage, undefined);
let cancelled = false;
response = await fetchWithUsage('https://fixture.invalid', {}, metadata, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoded('data: {"usage":{"prompt_tokens":7}}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
const reader = response.body.getReader(); await reader.read(); await reader.cancel(); assert.equal(cancelled, true); assert.equal(ledger.getUsageLedger().at(-1).status, 'cancelled');
const collector = createUsageCollector(true); collector.push(encoded('data: {"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":4,"thoughtsTokenCount":1,"totalTokenCount":13}}\n\n')); collector.finish();
assert.equal(collector.usage().total_tokens, 13); assert.equal(collector.usage().completion_tokens, 4); assert.equal(collector.usage().reasoning_tokens, 1);
const finish = ledger.beginUsageRequest(metadata); finish('completed', { prompt_tokens: 0, completion_tokens: -1, total_tokens: NaN, cached_tokens: 0 }); finish('error');
rows = ledger.getUsageLedger(); assert.equal(rows.at(-1).status, 'completed'); assert.equal(rows.at(-1).usage.prompt_tokens, 0); assert.equal(rows.at(-1).usage.completion_tokens, undefined);
const raw = [...kv.values()].join(' '); for (const secret of ['SECRET_API_KEY','PRIVATE_PROMPT','PRIVATE_REPLY','SECRET_URL','SECRET_AUTH','SECRET_NETWORK_ERROR','SECRET_ERROR_BODY']) assert.ok(!raw.includes(secret), secret + ' must not persist');
const summary = ledger.summarizeUsage(rows); assert.equal(summary.requests, 6); assert.equal(summary.errors, 3); assert.equal(summary.cacheCoverage, 3); assert.ok(summary.cacheHitRate >= 0 && summary.cacheHitRate <= 1);
ledger.clearUsageLedger(); assert.equal(ledger.getUsageLedger().length, 0);
const inFlight = ledger.beginUsageRequest(metadata); ledger.clearUsageLedger(); inFlight('completed', { prompt_tokens: 99 }); assert.equal(ledger.getUsageLedger().length, 0, 'Clearing must not resurrect an in-flight record');
const { supportsBalance, queryProviderBalance } = load('./provider-balance');
assert.equal(supportsBalance({ provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }), true);
for (const baseUrl of ['https://relay.invalid/v1','http://api.deepseek.com','https://api.deepseek.com@evil.invalid','https://api.deepseek.com/v1?key=private']) assert.equal(supportsBalance({ provider:'DeepSeek', baseUrl }), false);
let calls = 0; const balanceFetch = async (url, options) => { calls++; assert.equal(url, 'https://api.deepseek.com/user/balance'); assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }] })); };
const config = { id:'fixture-config',provider:'DeepSeek',apiKey:'SECRET_BALANCE_KEY',defaultModel:'fixture',enableImageRecognition:false,enableImageGeneration:false };
assert.equal((await queryProviderBalance(config,balanceFetch)).balances[0].total, '12.34');
await assert.rejects(queryProviderBalance({...config,baseUrl:'https://relay.invalid/v1'},balanceFetch)); assert.equal(calls, 1);
await assert.rejects(queryProviderBalance(config,async()=>new Response('{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"<bad>"}]}')));
const cause = ledger.beginUsageRequest({ ...metadata, reason: 'manual_compression' }); cause('completed');
assert.equal(ledger.getUsageLedger().at(-1).reason, 'manual_compression');
const injected = ledger.beginUsageRequest({ ...metadata, reason: 'PRIVATE_REASON_SECRET' }); injected('completed');
assert.equal(ledger.getUsageLedger().at(-1).reason, 'unknown'); assert.ok(![...kv.values()].join(' ').includes('PRIVATE_REASON_SECRET'));
const older = ledger.beginUsageRequest(metadata); older('completed'); assert.equal(ledger.getUsageLedger().at(-1).reason, 'unknown');
console.log('Usage ledger transport: JSON/SSE counters, Anthropic cache totals, failures, exactly-once receipts, missing/zero counts, fixed request causes/legacy unknown and privacy projection passed.');
