// Synthetic only: no real chats, model, account or VPS.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
const require = createRequire(import.meta.url), noop = () => {}, cache = new Map();
let transport = async () => { throw Error('Unexpected request'); };
const channels = [];
class Channel {
    constructor(name) { this.name = name; channels.push(this); }
    postMessage(data) { for (const channel of channels) if (channel !== this && channel.name === this.name) channel.onmessage?.({ data }); }
}
function load(file, mocks = {}, extras = {}) {
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require: name => mocks[name] ?? (name.startsWith('node:') ? require(name) : new Proxy({}, { get: () => noop })),
        fetch: (...args) => transport(...args), window: {}, console: { log: noop, warn: noop, error: noop }, process: { env: {} }, URL, Request, Response, Headers, Blob, ReadableStream,
        TextDecoder, TextEncoder, AbortController, AbortSignal, DOMException, Error, TypeError, Date, JSON, Math, Promise, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval, ...extras });
    return module.exports;
}
const db = { kvGet: key => cache.get(key), kvSet: (key, value) => cache.set(key, value), kvRemove: key => cache.delete(key), registerKvMigration: noop };
const ep = load('../lib/xinchao-ephemeral.ts');
const chat = load('../lib/xinchao-chat.ts', { './kv-db': db, './xinchao-core': { fixedCoreMatches: async()=>true, innerPreferences:()=>({binding:null,bodyInChat:false}) }, './xinchao-ephemeral': ep }, { BroadcastChannel: Channel });
const otherCache = new Map(), other = load('../lib/xinchao-chat.ts', { './kv-db': { ...db, kvGet: key => otherCache.get(key), kvSet: (key, value) => otherCache.set(key, value) }, './xinchao-core': { fixedCoreMatches: async()=>true, innerPreferences:()=>({binding:null,bodyInChat:false}) }, './xinchao-ephemeral': ep }, { BroadcastChannel: Channel });
let nowCalls = 0;
const settings = { enabled: true, sessionId: 'selected-chat', characterId: 'selected-actor' };
const text = 'PRIVATE_SYNTHETIC_NOW';
const nowResponse = () => Response.json({ ok: true, protocol: 'float-xinchao-now/v1', now: { available: true, text, revision: 3, generatedAt: new Date().toISOString() } });
transport = async (url, init) => { nowCalls++; assert.equal(url, '/api/shared-memory/xinchao/now'); assert.equal(init.method, 'POST'); assert.equal(init.body, undefined); return nowResponse(); };
assert.equal(chat.xinchaoChatSettings().enabled, false);
assert.equal((await chat.prepareXinchaoChatLayer(settings.sessionId, settings.characterId)).content, undefined); assert.equal(nowCalls, 0);
chat.setXinchaoChatSettings(settings); assert.equal(other.xinchaoChatSettings().enabled, true);
await chat.prepareXinchaoChatLayer('another-chat', settings.characterId); await chat.prepareXinchaoChatLayer(settings.sessionId, 'another-actor'); assert.equal(nowCalls, 0);
const unsubscribe = chat.subscribeXinchaoChat(() => { throw Error('Synthetic UI notice failure'); });
const layer = await chat.prepareXinchaoChatLayer(settings.sessionId, settings.characterId); unsubscribe(); assert.ok(layer.content.includes(text)); assert.equal(nowCalls, 1);
const messages = [{ role: 'system', content: 'stable-prefix' }, { role: 'system', content: layer.content }, { role: 'user', content: 'user-input' }];
assert.equal(chat.allowedXinchaoLayers(messages).length, 3);
assert.ok(!JSON.stringify(ep.redactXinchaoLayers(messages)).includes(text));
const merged = [{ role: 'system', content: 'PREFIX\n' + layer.content + '\nSUFFIX' }];
assert.ok(!JSON.stringify(ep.redactXinchaoLayers(merged)).includes(text));
assert.ok(ep.withoutXinchaoLayers(merged)[0].content.includes('SUFFIX'));
assert.ok(!JSON.stringify(ep.withoutXinchaoLayers(merged)).includes(text));
other.setXinchaoChatSettings({ ...settings, enabled: false });
assert.equal(chat.xinchaoChatSettings().enabled, false); assert.equal(chat.allowedXinchaoLayers(messages).length, 2); assert.ok(!JSON.stringify(chat.allowedXinchaoLayers(merged)).includes(text));
chat.setXinchaoChatSettings(settings);
let release;
transport = async () => new Promise(resolve => { release = () => resolve(nowResponse()); });
const late = chat.prepareXinchaoChatLayer(settings.sessionId, settings.characterId);
other.setXinchaoChatSettings({ ...settings, enabled: false }); release(); assert.equal((await late).content, undefined);
chat.setXinchaoChatSettings(settings);
transport = async () => { throw Error('Synthetic disconnected service'); };
assert.ok((await chat.prepareXinchaoChatLayer(settings.sessionId, settings.characterId)).warning.includes('继续聊天'));
const abort = new AbortController(); abort.abort(); assert.equal((await chat.prepareXinchaoChatLayer(settings.sessionId, settings.characterId, abort.signal)).warning, undefined);
assert.ok(!JSON.stringify([...cache.values(), ...otherCache.values()]).includes(text));
assert.ok(!JSON.stringify(chat.allowedXinchaoLayers(messages)).includes(text), 'Re-enabling never revives a previous activation layer');
transport = async () => nowResponse();
messages[1].content = (await chat.prepareXinchaoChatLayer(settings.sessionId, settings.characterId)).content;

const counter = load('../lib/token-counter.ts'), budget = load('../lib/consolidation-budget.ts', { './token-counter': counter });
const protocol = load('../lib/consolidation-protocol.ts', { './token-counter': counter });
const helper = load('../lib/api-helpers.ts');
const adapter = load('../lib/llm-provider-adapter.ts', { './api-helpers': helper, './generation-parameters': { resolveEnabledGenerationParameters: () => new Set() } });
const logs = load('../lib/api-log-store.ts', { './kv-db': db, './xinchao-core': { fixedCoreMatches: async()=>true, innerPreferences:()=>({binding:null,bodyInChat:false}) }, './xinchao-ephemeral': ep });
const debug = [];
class Macro { expand(value) { return value; } }
let modelCalls = 0, expectedIncluded = true;
const engine = load('../lib/chat-engine.ts', {
    './xinchao-chat': chat, './xinchao-core': { fixedCoreMatches: async()=>true, innerPreferences:()=>({binding:null,bodyInChat:false}) }, './xinchao-ephemeral': ep, './api-log-store': logs, './debug-store': { setDebugPromptSnapshot: snapshot => debug.push(snapshot) },
    './llm-provider-adapter': adapter, './consolidation-budget': budget, './consolidation-protocol': protocol,
    './macro-engine': { MacroEngine: Macro, postProcessTrim: value => value }, './sse-json': load('../lib/sse-json.ts'),
    './chat-plugin-hooks': { runChatPluginTransform: async (_event, payload) => payload, emitChatPluginEvent: noop },
    './chat-avatar-intent': { applyWithProtectedAvatarDecisionMarkers: (value, transform) => transform(value) }, './llm-prompt-assembler': { applyOutputRegex: value => value },
    './content-tag-utils': { mergeAppTags: () => [], getActiveAppTags: () => [] },
    './llm-http': { fetchLlmPayload: async request => {
        modelCalls++; assert.equal(JSON.stringify(request.body).includes(text), expectedIncluded);
        const message = { content: '普通合成回复' };
        if (request.body.stream) {
            const event = request.providerKind === 'anthropic' ? { type: 'content_block_delta', delta: { type: 'text_delta', text: message.content } } : request.providerKind === 'gemini' ? { candidates: [{ content: { parts: [{ text: message.content }] } }] } : { choices: [{ delta: message }] };
            return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return request.providerKind === 'anthropic' ? Response.json({ content: [{ type: 'text', text: message.content }] }) : request.providerKind === 'gemini' ? Response.json({ candidates: [{ content: { parts: [{ text: message.content }] } }] }) : Response.json({ choices: [{ message }] });
    } },
});
const config = { id: 'fixture-model', provider: 'Custom', baseUrl: 'https://synthetic-model.invalid/v1', apiKey: 'synthetic', defaultModel: 'synthetic', contextWindowTokens: 64000 };
for (const provider of ['Custom', 'Anthropic', 'Google']) for (const mode of ['json', 'sse', 'native-json', 'native-sse']) {
    const chosen = { ...config, provider, baseUrl: provider === 'Custom' ? config.baseUrl : undefined };
    const options = { skipOutputRegex: true, debugSessionId: settings.sessionId };
    if (mode === 'json') await engine.sendLLMRequest(chosen, null, messages, [], undefined, options);
    else if (mode === 'sse') await engine.sendLLMStreamRequest(chosen, null, messages, [], undefined, options);
    else if (mode === 'native-json') await engine.sendLLMToolRequest(chosen, null, messages, [], [], undefined, options);
    else await engine.sendLLMToolStreamRequest(chosen, null, messages, [], [], undefined, options);
}
assert.equal(modelCalls, 12);
assert.ok(!JSON.stringify(debug).includes(text)); assert.ok(!JSON.stringify(logs.getApiLogs()).includes(text));
chat.setXinchaoChatSettings({ ...settings, enabled: false }); expectedIncluded = false;
await engine.sendLLMRequest(config, null, messages, [], undefined, { skipOutputRegex: true });
assert.equal(modelCalls, 13); // disabling removes the stale layer, not the normal chat

// Execute the actual single-chat hook block with real scope/settings helpers.
const source = readFileSync(new URL('../lib/chat-engine.ts', import.meta.url), 'utf8');
const start = source.indexOf('    const lastUserTurn = history[history.length - 1];', source.indexOf('async function generateChatCompletionCore'));
const end = source.indexOf('    if (toolsEnabled && nativeToolProtocolForConfig(config) && getEnabledTools', start);
assert.ok(start > 0 && end > start);
const hookCode = ts.transpileModule('(async function(session,character,history,options,requestAppTags,llmMessages,config,callbacks){' + source.slice(start, end) + '\nreturn llmMessages;})', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const hookGlobals = {
    preset: null, toolsEnabled: false, prepareXinchaoChatLayer: chat.prepareXinchaoChatLayer, noteXinchaoChatStatus: chat.noteXinchaoChatStatus, insertConsolidationLayer: protocol.insertConsolidationLayer,
    guardConsolidationBudget: budget.guardConsolidationBudget, buildProviderRequest: adapter.buildProviderRequest, toLlmRequestMessages: adapter.toLlmRequestMessages, withoutXinchaoLayers: ep.withoutXinchaoLayers,
};
const hook = new vm.Script(hookCode).runInNewContext(hookGlobals);
transport = async () => { nowCalls++; return nowResponse(); }; chat.setXinchaoChatSettings(settings);
const session = { id: settings.sessionId }, character = { id: settings.characterId }, history = [{ role: 'user', sessionId: session.id }];
const runHook = (s = session, h = history, options = {}, tags = [], chosen = config) => hook(s, character, h, options, tags, [{ role: 'system', content: 'stable-persona' }, { role: 'user', content: 'synthetic-user' }], chosen, { onToolNotice() { throw Error('notice UI failure'); } });
const beforeHook = nowCalls;
for (const [s, h, opts, tags] of [[{ ...session, isGroup: true }, history, {}, []], [session, history, { appId: 'life' }, []], [session, history, {}, ['followup']], [session, [{ role: 'assistant' }], {}, []], [session, history, { ephemeralSystemNote: 'scheduled' }, []]]) {
    assert.ok(!JSON.stringify(await runHook(s, h, opts, tags)).includes(text));
}
assert.equal(nowCalls, beforeHook);
assert.ok(JSON.stringify(await runHook()).includes(text), chat.xinchaoChatStatus()); assert.equal(nowCalls, beforeHook + 1);
assert.ok(!JSON.stringify(await runHook(session, history, {}, [], { ...config, contextWindowTokens: undefined })).includes(text));
let description = 'small synthetic tool';
const nativeHook = new vm.Script(hookCode).runInNewContext({ ...hookGlobals, toolsEnabled: true, userIdentity: { name: 'Synthetic user' }, nativeToolProtocolForConfig: () => 'openai', getEnabledTools: () => [], loadChatSessions: () => [], normalizeNativeExpandedToolSourceIds: () => [], buildNativeChatTools: () => ({ definitions: [{ name: 'synthetic_tool', description, parameters: { type: 'object', properties: {} } }] }) });
const nativeMessages = () => [{ role: 'system', content: 'stable-prefix' }, { role: 'user', content: 'user' }];
assert.ok(JSON.stringify(await nativeHook(session, character, history, {}, [], nativeMessages(), config, {})).includes(text));
description = 'x'.repeat(500000);
assert.ok(!JSON.stringify(await nativeHook(session, character, history, {}, [], nativeMessages(), config, {})).includes(text), 'Native tool definitions count toward the state budget');
assert.ok(source.includes('withoutXinchaoLayers(snapshotMessages)'));
for (const file of ['../lib/workspace-client.ts', '../lib/group-chat-engine.ts']) assert.ok(!readFileSync(new URL(file, import.meta.url), 'utf8').includes('xinchao'));
console.log('Xinchao optional chat state: default-off explicit binding, cancelled/stale reads, cross-tab disable, nonblocking notices, actual scope hook, three-provider/four-path requests, per-request disable, log/debug redaction and no work/private/group wiring passed. Synthetic only.');
