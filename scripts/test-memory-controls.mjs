// Node 24+; run with --experimental-vm-modules. No personal data or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const cache = new Map();
const entries = new Map();
let available = true;
let closes = 0;
let writes = 0;
let embeddingCalls = 0;
let apiLookups = 0;
let onRead;
let onEmbedding;
let sharedWrites = 0;
let sharedFailure = false;
let sharedPaused = false;
let sharedRecallEntries;
let lastRecalledEntries;
let lastManual = false;
let lastSharedEntry;
let exerciseSummary = false;
let modelCalls = 0;
const request = value => {
    const req = {};
    queueMicrotask(() => { req.result = value; req.onsuccess?.(); });
    return req;
};
// Minimal IDB boundary: exercise real storage/policy code without browser data.
const db = {
    close() { closes++; },
    transaction() {
        const tx = {};
        const store = {
            put(entry) {
                writes++;
                entries.set(entry.id, entry);
                queueMicrotask(() => tx.oncomplete?.());
            },
            delete(id) {
                entries.delete(id);
                queueMicrotask(() => tx.oncomplete?.());
            },
            getAll() { return request([...entries.values()]); },
            index() {
                return { getAll(characterId) {
                    onRead?.();
                    return request([...entries.values()].filter(e => e.characterId === characterId));
                } };
            },
        };
        tx.objectStore = () => store;
        return tx;
    },
};
const context = vm.createContext({ console, window: {}, indexedDB: {}, queueMicrotask });
const fixtures = {
    "kv-db": {
        kvGet: key => cache.get(key), kvSet: (key, value) => cache.set(key, value),
        kvRemove: key => cache.delete(key), registerKvMigration() {}, registerDynamicPrefix() {},
    },
    "idb-open": { openIndexedDbAtLeast: async () => available ? db : null },
    "shared-memory-client": {
        loadSharedMemoryEntries: async characterId => {
            if (sharedFailure) throw new Error("synthetic shared offline");
            return sharedRecallEntries ?? [{ ...entry, id: "ombre:test", characterId, content: "canonical shared content", metadata: { sharedCanonicalId: "test" } }];
        },
        saveSharedMemoryEntry: async (_entry, manual) => {
            if (sharedFailure) throw new Error("synthetic shared offline");
            sharedWrites++; lastSharedEntry = _entry; lastManual = manual === true; return { state: "saved" };
        },
        noteSharedMemoryRecall: async recalled => { lastRecalledEntries = recalled; },
        ensureSharedMemoryWritesAllowed: async () => { if (sharedPaused) throw new Error("synthetic shared paused"); },
    },
    "settings-storage": { resolveAuxiliaryApiConfig() { apiLookups++; return {}; } },
    "memory-embedding": {
        generateEmbedding: async () => { embeddingCalls++; onEmbedding?.(); return [1]; },
        resolveEmbeddingModel: () => "test-only", cosineSimilarity: () => 1,
    },
    "token-counter": { estimateTokens: text => text.length },
    "api-helpers": { simpleLLMCall() { if (!exerciseSummary) throw new Error("Paused pipeline must not call model"); modelCalls++; return { content: "合成模型总结" }; } },
    "short-term-assembler": {
        loadNativeTimeline() { if (!exerciseSummary) throw new Error("Paused pipeline must not read history"); return Array.from({ length: 4 }, (_, i) => ({ id: String(i), sourceApp: "chat", sessionId: "synthetic-session" })); },
        formatTimelineForSummarization() { return { eventsText: "合成事件", earliest: "2026-11-08T00:00:00Z", latest: "2026-11-08T01:00:00Z" }; },
        filterTimelineByAllowedSources: entries => entries,
    },
    "story-storage": { loadStorySessions() { throw new Error("Paused pipeline must not read stories"); }, resolveStoryMemorySettings() {} },
};
const modules = new Map();
async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const fixture = fixtures[name];
    const mod = fixture
        ? new vm.SyntheticModule(Object.keys(fixture), function () {
            for (const [key, value] of Object.entries(fixture)) this.setExport(key, value);
        }, { context })
        : new vm.SourceTextModule(stripTypeScriptTypes(
            readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"),
        ), { context, identifier: name });
    modules.set(name, mod);
    await mod.link(specifier => load(specifier.replace(/^\.\//, "")));
    return mod;
}
const serviceModule = await load("memory-service");
await serviceModule.evaluate();
const storage = modules.get("memory-storage").namespace;
const service = serviceModule.namespace;
const defaults = modules.get("memory-types").namespace.DEFAULT_MEMORY_CONFIG;
const setConfig = patch => storage.saveMemoryConfig({ ...defaults, ...patch });
const entry = { id: "test", characterId: "c", type: "long_term", sourceApp: "chat",
    content: "test memory", importance: 1, embedding: [1], createdAt: "2026-01-01", updatedAt: "2026-01-01" };

// Old configurations preserve behavior; saving both controls persists independently.
assert.equal(storage.loadMemoryConfig().automaticRecallEnabled, true);
assert.equal(storage.loadMemoryConfig().automaticWritesPaused, false);
setConfig({ automaticRecallEnabled: false, automaticWritesPaused: true });
assert.equal(storage.loadMemoryConfig().automaticRecallEnabled, false);
assert.equal(storage.loadMemoryConfig().automaticWritesPaused, true);
await assert.rejects(storage.saveMemoryEntry(entry), /已暂停/);
assert.equal(writes, 0);
assert.equal(closes, 0, "A known pause stops before opening a database");
await storage.saveMemoryEntry(entry, { userInitiated: true });
assert.equal(writes, 1, "Manual panel editing remains available");
assert.equal((await storage.loadMemoryEntriesByType("c", "long_term")).length, 1, "Manual retrieval remains available");
assert.equal((await service.retrieveMemoriesForPrompt("c", "query", defaults)).length, 0, "Stale enabled snapshot cannot bypass current setting");
assert.equal((await service.retrieveCoreMemoriesForPrompt("c", defaults)).length, 0);
assert.equal(embeddingCalls, 0);
setConfig({});
await storage.saveMemoryEntry(entry);
assert.equal(writes, 2, "Program writes resume");
assert.equal((await service.retrieveMemoriesForPrompt("c", "query", defaults)).length, 1);
entries.set("core", { ...entry, id: "core", type: "core" });
assert.equal((await service.retrieveCoreMemoriesForPrompt("c", defaults)).length, 1);

// A setting changed while awaiting IDB or embedding must also take effect.
onRead = () => setConfig({ automaticRecallEnabled: false });
assert.equal((await service.retrieveMemoriesForPrompt("c", "query", defaults)).length, 0);
setConfig({});
assert.equal((await service.retrieveCoreMemoriesForPrompt("c", defaults)).length, 0);
onRead = undefined;
setConfig({});
onEmbedding = () => setConfig({ automaticRecallEnabled: false });
assert.equal((await service.retrieveMemoriesForPrompt("c", "query", { ...defaults, longTermTokenBudget: 1 })).length, 0);
assert.equal(embeddingCalls, 1);
onEmbedding = undefined;

// Simulate a pause after openDb yields but before commit.
setConfig({});
const inFlight = storage.saveMemoryEntry({ ...entry, id: "in-flight" });
setConfig({ automaticWritesPaused: true });
await assert.rejects(inFlight, /已暂停/);
assert.equal(entries.has("in-flight"), false);

// Both direct and automatic summarization paths stop before history/API work.
const summarizer = await load("memory-summarizer");
await summarizer.evaluate();
const core = modules.get("core-memory-builder").namespace;
const lookupsBefore = apiLookups;
assert.equal((await summarizer.namespace.runSummarizationPipeline("c", "test")).success, false);
await summarizer.namespace.maybeRunSummarization("c", "test");
assert.equal((await core.runCoreMemoryPipeline("c", "test")).success, false);
await core.maybeRunCoreMemoryPipeline("c", "test");
assert.equal(apiLookups, lookupsBefore);
// Switching to shared redirects every common storage caller, with no local copy.
setConfig({ memorySource: "shared" });
const localWrites = writes;
await storage.saveMemoryEntry(entry);
assert.equal(sharedWrites, 1);
assert.equal(writes, localWrites);
assert.equal((await storage.loadMemoryEntriesByType("c", "long_term"))[0].content, "canonical shared content");
assert.equal((await service.retrieveMemoriesForPrompt("c", "query", defaults))[0].content, "canonical shared content");

// Exercise real shared retrieval: oversized candidates must not block later facts.
const candidate = (id, content) => ({ ...entry, id, content, metadata: { sharedCanonicalId: id } });
const recallCases = [
    {
        name: "Oversized first candidate",
        candidates: [candidate("large", "x".repeat(100)), candidate("short", "short.")],
        expected: ["short"],
    },
    {
        name: "Middle candidate exceeds remaining budget, later candidate fits exactly",
        candidates: [candidate("first", "first."), candidate("first", "other."),
            candidate("duplicate-content", "  first.  "), candidate("blank", "   "),
            candidate("middle", "1234567"), candidate("last", " last "), candidate("overflow", "x")],
        expected: ["first", "last"],
    },
];
for (const { name, candidates, expected } of recallCases) {
    sharedRecallEntries = candidates;
    const originals = candidates.map(candidate => candidate.content);
    const recalled = await service.retrieveMemoriesForPrompt("c", "query", { ...defaults, longTermTokenBudget: 20 });
    assert.deepEqual(Array.from(recalled, candidate => candidate.id), expected, name);
    assert.ok(recalled.reduce((used, candidate) => used + candidate.content.length + 4, 0) <= 20, "Total budget includes per-entry overhead");
    assert.ok(recalled.every(candidate => candidates.includes(candidate)), "Return intact canonical entries, without truncation or copies");
    assert.deepEqual(candidates.map(candidate => candidate.content), originals, "Neither selected nor skipped canonical content is changed");
    assert.deepEqual(Array.from(lastRecalledEntries, candidate => candidate.id), expected, "Only selected facts receive recall bookkeeping");
}
sharedRecallEntries = undefined;
await storage.saveMemoryEntry(entry, { userInitiated: true });
assert.equal(lastManual, true);
sharedFailure = true;
await assert.rejects(storage.saveMemoryEntry(entry), /shared offline/);
await assert.rejects(storage.loadMemoryEntries("c"), /shared offline/);
assert.equal(writes, localWrites, "Unavailable canonical service must not fall back to local facts");
sharedFailure = false;
await assert.rejects(storage.deleteMemoryEntry("ombre:test"), /删除尚未接入/);
sharedPaused = true;
const callsBeforeSharedPause = apiLookups;
assert.equal((await summarizer.namespace.runSummarizationPipeline("c", "test")).success, false);
assert.equal((await core.runCoreMemoryPipeline("c", "test")).success, false);
assert.equal(apiLookups, callsBeforeSharedPause, "Known shared pause stops before model setup");
sharedPaused = false;
exerciseSummary = true;
const modelsBefore = modelCalls;
assert.equal((await summarizer.namespace.runSummarizationPipeline("c", "test", { force: true })).success, false);
assert.equal((await summarizer.namespace.runSummarizationPipeline("c", "test", { force: true, writeLongTermMemory: false, writeCoreMemory: true })).success, false);
assert.equal(modelCalls, modelsBefore, "Shared consolidation must never invoke the old independent summary model");
const oldCounter = storage.getEventCounter("c"); storage.incrementEventCounter("c");
assert.equal(storage.getEventCounter("c"), oldCounter, "Shared source does not advance the legacy per-character scheduler");
exerciseSummary = false;
setConfig({});
const switching = storage.saveMemoryEntry({ ...entry, id: "switching" });
setConfig({ memorySource: "shared" });
await switching;
assert.equal(writes, localWrites, "Source changed during DB open: do not write the old local target");
setConfig({ maxLongTermEntries: 1, vectorRecallEnabled: false, autoBuildCoreEnabled: false });
exerciseSummary = true;
assert.equal((await summarizer.namespace.runSummarizationPipeline("c", "test", { force: true })).success, true);
assert.equal((await storage.loadMemoryEntriesByType("c", "long_term")).length, 1);
assert.equal(entries.has("core"), true, "Local long-term retention must never trim core memories");
exerciseSummary = false;
setConfig({});
available = false;
await assert.rejects(storage.saveMemoryEntry(entry, { userInitiated: true }), /数据库不可用/);
console.log("Memory controls: pause/resume, manual access, in-flight guards, pipeline preflight and shared recall budget/duplicate regressions passed.");
