import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
    const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: name => mocks[name] ?? require(name),
        process: { env: {} }, URL, URLSearchParams, AbortSignal, TextDecoder, TextEncoder, Date, Response });
    return module.exports;
}
const api = load("../lib/server/shared-memory.ts");
const review = load("../lib/server/shared-memory-review.ts", { "./shared-memory": api, "../orbis-memory-import": load("../lib/orbis-memory-import.ts") });
const config = { baseUrl: "https://ombre.example", password: "synthetic-password",
    accessToken: "synthetic-browser-token-".repeat(2), reviewToken: "synthetic-service-token-".repeat(2) };
const entry = { id: "abc123", content: "合成正文", metadata: { source: "test" }, revision: "a".repeat(64) };
const candidate = { id: "candidate1", kind: "edit", targetId: entry.id, content: "修正的合成正文", source: { origin: "float_user" },
    before: entry, state: "pending", version: 1, createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z" };
const calls = [];
let wrongProtocol = false;
let conflict = false;
let latentMode;
const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, `Bearer ${config.reviewToken}`);
    assert.ok(!JSON.stringify(options).includes(config.accessToken));
    assert.ok(!JSON.stringify(options).includes(config.password));
    assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error");
    const path = new URL(url).pathname.split("/").at(-1);
    if (conflict) return Response.json({ ok: false, code: "conflict", error: config.reviewToken }, { status: 409 });
    if (path === "status") return Response.json({ ok: true, protocol: wrongProtocol ? "unknown" : "float-review/v2", policy: { paused: false, reviewRequired: false, version: 1 }, nativeWritesReviewed: false, latent: Boolean(latentMode), latentMode, latentIndexState: "building" });
    if (path === "detail") return Response.json({ ok: true, entry });
    if (path === "history") return Response.json({ ok: true, history: [{ id: "operation1", targetId: entry.id, before: entry, after: entry, afterRevision: entry.revision, source: {}, at: "2026-11-08T00:00:00Z" }] });
    if (path === "candidates") return Response.json({ ok: true, candidates: [candidate], total: 1 });
    if (path === "memories") return Response.json({ok:true,entries:[entry]});
    if (path === "catalog") return Response.json({ ok: true, entries: [{...entry,state:new URL(url).searchParams.get("state")}],nextCursor:null,pending:[] });
    if (path === "import_batches") return Response.json({ok:true,batches:[{id:"batch-1",at:"2026-11-08T00:00:00Z",total:1,created:1,undone:0,pending:0}]});
    assert.equal(options.method, "POST");
    if (path === "policy") return Response.json({ ok: true, policy: { paused: true, reviewRequired: false, version: 2 } });
    if (path === "manage") { const payload=JSON.parse(options.body);return Response.json({ok:true,management:{id:"operation1",targetId:payload.targetId,operation:payload.operation,state:"completed"}}); }
    if (path === "import_note") return Response.json({ok:true,importReceipt:{targetId:entry.id,batchId:"batch-1",state:"created",owned:true}});
    if (path === "import_rollback") return Response.json({ok:true,results:[{targetId:entry.id,state:"rolled_back"}],nextCursor:null});
    return Response.json({ ok: true, candidate });
};
const client = review.createOmbreReviewClient(config, fetcher);
assert.equal((await client.status()).available, true);
latentMode = "semantic-hybrid-v1";
assert.equal((await client.status()).latentMode, "semantic-hybrid-v1");
assert.equal((await client.status()).latentIndexState, "building");
latentMode = "unknown-future-mode";
await assert.rejects(client.status(), error => error.code === "review_protocol");
latentMode = undefined;
assert.equal((await client.detail(entry.id)).revision, entry.revision);
assert.equal((await client.candidates()).candidates[0].version, 1);
assert.equal((await client.history(entry.id))[0].afterRevision, entry.revision);
assert.equal((await client.mutate("propose", { content: "test" })).candidate.state, "pending");
assert.equal((await client.mutate("policy", { paused: true, version: 1 })).policy.paused, true);
assert.equal((await client.catalog("deleted")).entries[0].state,"deleted");
assert.equal((await client.mutate("manage",{targetId:entry.id,operation:"delete",baseRevision:entry.revision,clientKey:"management1"})).management.state,"completed");
assert.equal((await client.memories("合成查询","latent"))[0].id,entry.id);
assert.ok(calls.at(-1).url.includes("engine=latent"));
assert.equal((await client.importBatches()).batches[0].id,"batch-1");
const sourceNote={id:"source1",assistantId:"fixture",body:"只导入虚构记忆",createdAt:1,updatedAt:2};
assert.equal((await client.mutate("import_note",{batchId:"batch-1",note:sourceNote})).importReceipt.state,"created");
const beforeInvalidImport=calls.length;
await assert.rejects(client.mutate("import_note",{batchId:"batch-1",note:{...sourceNote,messages:["private chat must not be uploaded"]}}),error=>error.status===400);
assert.equal(calls.length,beforeInvalidImport);
assert.equal((await client.mutate("import_rollback",{batchId:"batch-1"})).results[0].state,"rolled_back");
const before = calls.length;
await assert.rejects(client.detail("../escape"), error => error.status === 400);
await assert.rejects(client.mutate("purge", {}), error => error.status === 400);
assert.equal(calls.length, before);
wrongProtocol = true;
await assert.rejects(client.status(), error => error.code === "review_protocol");
wrongProtocol = false; conflict = true;
await assert.rejects(client.mutate("approve", { id: "candidate1", version: 1 }), error => error.status === 409 && !error.message.includes(config.reviewToken));
conflict = false;
assert.equal((await review.createOmbreReviewClient({ ...config, reviewToken: undefined }, () => { throw Error("No network expected"); }).status()).available, false);
const unavailable = review.createOmbreReviewClient(config, async () => new Response("Not Found", { status: 404 }));
await assert.rejects(unavailable.status(), error => error.status === 501);
const timeout = review.createOmbreReviewClient(config, async () => { throw Error(config.reviewToken); });
await assert.rejects(timeout.mutate("approve", {}), error => error.status === 503 && !error.message.includes(config.reviewToken));
const mismatch = review.createOmbreReviewClient(config, async () => Response.json({ ok: true, entry: { ...entry, revision: "" } }));
await assert.rejects(mismatch.detail(entry.id), error => error.code === "review_protocol");

let writes = 0;
const route = load("../app/api/shared-memory/route.ts", {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/server/shared-memory": { ...api, readSharedMemoryConfig: () => config },
    "@/lib/server/shared-memory-review": { createOmbreReviewClient: () => ({
        ...client, mutate: async (action, body) => { writes++; return client.mutate(action, body); },
    }) },
});
const headers = { origin: "https://float.example", "x-float-memory-access-token": config.accessToken, "content-type": "application/json" };
const post = (body, overrides = {}) => new Request("https://float.example/api/shared-memory", { method: "POST", headers: { ...headers, ...overrides }, body });
assert.equal((await route.POST(post(JSON.stringify({ action: "review_propose", content: "test" }), { origin: "https://evil.example" }))).status, 403);
assert.equal((await route.POST(post(JSON.stringify({ action: "review_approve" }), { "x-float-memory-access-token": "wrong" }))).status, 401);
assert.equal((await route.POST(post("[]"))).status, 400);
assert.equal((await route.POST(post("not json"))).status, 400);
assert.equal((await route.POST(post("x".repeat(65537)))).status, 413);
assert.equal(writes, 0);
const accepted = await route.POST(post(JSON.stringify({ action: "review_propose", content: "test" })));
assert.equal(accepted.status, 200); assert.equal(writes, 1);
assert.equal(accepted.headers.get("cache-control"), "private, no-store");
const responseText = await accepted.text();
assert.ok(!responseText.includes(config.reviewToken) && !responseText.includes(config.password));
const connected = await route.POST(post(JSON.stringify({ action: "connect" })));
assert.equal(connected.status, 200);
const cookieHeader = connected.headers.get("set-cookie");
assert.ok(cookieHeader.includes("HttpOnly") && cookieHeader.includes("SameSite=Strict") && cookieHeader.includes("Secure"));
assert.ok(!cookieHeader.includes(config.accessToken) && !cookieHeader.includes(config.reviewToken));
const ownerCookie = cookieHeader.split(";")[0];
const ownerRequest = new Request("https://float.example/api/shared-memory", { headers: { cookie: ownerCookie } });
assert.equal(api.authorizeSharedMemory(ownerRequest, config), true);
assert.equal(api.authorizeSharedMemory(ownerRequest, { ...config, reviewToken: "rotated-service-key-".repeat(2) }), false);
assert.equal(api.authorizeSharedMemory(ownerRequest, config, true), false, "Reissuing a session still requires the explicit access code");
const tampered = new Request("https://float.example/api/shared-memory", { headers: { cookie: ownerCookie.slice(0, -1) + (ownerCookie.endsWith("a") ? "b" : "a") } });
assert.equal(api.authorizeSharedMemory(tampered, config), false);
const cookieWrite = await route.POST(new Request("https://float.example/api/shared-memory", { method: "POST", headers: { origin: "https://float.example", cookie: ownerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ action: "review_record", kind: "create", content: "test", clientKey: "cookie-record" }) }));
assert.equal(cookieWrite.status, 200);
const disconnected = await route.POST(new Request("https://float.example/api/shared-memory", { method: "POST", headers: { origin: "https://float.example", cookie: ownerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ action: "disconnect" }) }));
assert.ok(disconnected.headers.get("set-cookie").includes("Max-Age=0"));
console.log("Shared review proxy: opt-in protocol, server-only token, conflict/redaction, bounded requests and human gate passed.");
