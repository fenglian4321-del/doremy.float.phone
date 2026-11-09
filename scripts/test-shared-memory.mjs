import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
    const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, {
        module, exports: module.exports, require: name => mocks[name] ?? require(name),
        process: { env: {} }, URL, URLSearchParams, AbortSignal, TextDecoder, Date, Response,
    });
    return module.exports;
}
const api = load("../lib/server/shared-memory.ts");
const token = "synthetic-access-code-".repeat(2);
const config = { baseUrl: "https://ombre.example", password: "synthetic-server-password", accessToken: token };
const env = {
    FLOAT_SHARED_MEMORY_OMBRE_URL: config.baseUrl,
    FLOAT_SHARED_MEMORY_OMBRE_PASSWORD: config.password,
    FLOAT_SHARED_MEMORY_ACCESS_TOKEN: token,
};
assert.equal(api.readSharedMemoryConfig({}), null);
assert.equal(api.readSharedMemoryConfig(env).baseUrl, config.baseUrl);
for (const url of ["file:///tmp", "http://ombre.internal", "https://user:pass@ombre.example", "https://ombre.example/mcp", "https://ombre.example?q=1", "https://ombre.example/#x"]) {
    assert.throws(() => api.readSharedMemoryConfig({ ...env, FLOAT_SHARED_MEMORY_OMBRE_URL: url }), /配置无效/);
}
assert.equal(api.readSharedMemoryConfig({ ...env, FLOAT_SHARED_MEMORY_OMBRE_URL: "http://ombre.internal", FLOAT_SHARED_MEMORY_ALLOW_HTTP: "true" }).baseUrl, "http://ombre.internal");
assert.throws(() => api.readSharedMemoryConfig({ ...env, FLOAT_SHARED_MEMORY_ACCESS_TOKEN: "short" }), /配置无效/);
assert.equal(api.authorizeSharedMemory(new Request("https://float.example/api/shared-memory"), config), false);
assert.equal(api.authorizeSharedMemory(new Request("https://float.example/api/shared-memory", { headers: { "x-float-memory-access-token": token } }), config), true);
assert.equal(api.authorizeSharedMemory(new Request("https://float.example/api/shared-memory", { headers: { "x-float-memory-access-token": "x".repeat(600) } }), config), false);

const list = [{ id: "abc123", name: "合成记忆", type: "dynamic", tags: ["测试"], domain: ["日常"],
    created: "2026-11-08T08:00:00Z", content_preview: "仅为测试", dont_surface: true }];
const calls = [];
let loginCount = 0;
let expireOnce = false;
let malformed = false;
let deleted = false;
const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.ok(!JSON.stringify(options).includes(token), "Float access code must never reach Ombre");
    if (url.endsWith("/auth/login")) {
        loginCount++;
        assert.equal(options.method, "POST");
        assert.equal(JSON.parse(options.body).password, config.password);
        return Response.json({ ok: true }, { headers: { "Set-Cookie": `ombre_session=synthetic_session_${loginCount}; Path=/; HttpOnly` } });
    }
    assert.match(options.headers.Cookie, /^ombre_session=synthetic_session_/);
    assert.equal(options.method, undefined, "Memory endpoints must remain read-only");
    if (expireOnce) { expireOnce = false; return Response.json({}, { status: 401 }); }
    if (url.includes("/api/bucket/")) return Response.json({ id: "abc123", content: "合成正文", metadata: deleted ? { deleted_at: "today" } : { source: "test" } });
    return Response.json(malformed ? { unexpected: [] } : list);
};
const reader = api.createOmbreReader(config, fetcher);
const [first, second] = await Promise.all([reader.list(), reader.list()]);
assert.equal(loginCount, 1, "Concurrent first reads share a single login");
assert.equal(first[0].id, "abc123");
assert.equal(second[0].dontSurface, true);
assert.equal(first[0].tags[0], "测试");
assert.equal((await reader.detail("abc123")).metadata.source, "test");
await reader.search("标签 & ? / #");
assert.ok(calls.at(-1).url.endsWith(`/api/search?q=${encodeURIComponent("标签 & ? / #")}`));
const countBefore = calls.length;
for (const id of ["../x", ".", "..", "a/b", "x?foo", "x#foo", "", "a".repeat(161)]) await assert.rejects(reader.detail(id), /ID 无效/);
await assert.rejects(reader.search(""), /搜索词/);
await assert.rejects(reader.search("a".repeat(501)), /搜索词/);
assert.equal(calls.length, countBefore, "Invalid inputs must not reach the remote service");
expireOnce = true;
await reader.list();
assert.equal(loginCount, 2, "Expired session renews once");
malformed = true;
await assert.rejects(reader.list(), /列表格式/);
malformed = false; deleted = true;
await assert.rejects(reader.detail("abc123"), /已移除/);
const leaking = api.createOmbreReader(config, async () => { throw new Error(config.password); });
await assert.rejects(leaking.list(), error => !error.message.includes(config.password) && error.code === "unreachable");
const noSession = api.createOmbreReader(config, async () => Response.json({ ok: true }));
await assert.rejects(noSession.list(), /未返回预期会话/);
const badAuth = api.createOmbreReader(config, async () => Response.json({ error: config.password }, { status: 401 }));
await assert.rejects(badAuth.list(), error => !error.message.includes(config.password) && error.code === "upstream_auth");
const withReadResponse = makeResponse => api.createOmbreReader(config, async url => url.endsWith("/auth/login")
    ? Response.json({ ok: true }, { headers: { "Set-Cookie": "ombre_session=synthetic_session; Path=/; HttpOnly" } })
    : makeResponse());
await assert.rejects(withReadResponse(() => new Response("<html>not a memory API</html>")).list(), error => error.code === "protocol");
await assert.rejects(withReadResponse(() => Response.json({ padding: "x".repeat(4 * 1024 * 1024) })).list(), error => error.code === "too_large");
await assert.rejects(withReadResponse(() => Response.json({ id: "other", content: "test", metadata: {} })).detail("abc123"), error => error.code === "protocol");
let persistentAuthCalls = 0;
const persistentAuth = api.createOmbreReader(config, async url => {
    persistentAuthCalls++;
    return url.endsWith("/auth/login")
        ? Response.json({}, { headers: { "Set-Cookie": "ombre_session=synthetic; HttpOnly" } })
        : Response.json({ error: config.password }, { status: 401 });
});
await assert.rejects(persistentAuth.list(), error => error.code === "upstream" && !error.message.includes(config.password));
assert.equal(persistentAuthCalls, 4, "A persistent 401 must stop after exactly one renewed read");

// Exercise the real route independently of middleware, including self-hosted exposure.
let enabled = true;
let routeReads = 0;
const route = load("../app/api/shared-memory/route.ts", {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/server/shared-memory-review": { createOmbreReviewClient: () => ({}) },
    "@/lib/server/shared-memory": { ...api, readSharedMemoryConfig: () => enabled ? config : null,
        getOmbreReader: () => ({
            list: async () => { routeReads++; return first; },
            search: async () => { routeReads++; return first; },
            detail: async () => { routeReads++; return { id: "abc123", content: "test", metadata: {} }; },
        }),
    },
});
const request = (params, headers = {}) => new Request(`https://float.example/api/shared-memory?${params}`, { headers });
const status = await route.GET(request("action=status"));
assert.equal((await status.json()).configured, true);
assert.equal(routeReads, 0);
const denied = await route.GET(request("action=list"));
assert.equal(denied.status, 401);
assert.equal(routeReads, 0);
const allowedHeaders = { "x-float-memory-access-token": token };
const crossSite = await route.GET(request("action=list", { ...allowedHeaders, origin: "https://evil.example" }));
assert.equal(crossSite.status, 403);
assert.equal(routeReads, 0);
const allowed = await route.GET(request("action=list", allowedHeaders));
assert.equal(allowed.status, 200);
assert.equal(allowed.headers.get("cache-control"), "private, no-store");
const body = JSON.stringify(await allowed.json());
assert.ok(!body.includes(config.password) && !body.includes(token) && !body.includes("synthetic_session"));
assert.equal(routeReads, 1);
assert.equal((await route.GET(request("action=write", allowedHeaders))).status, 400);
assert.equal(routeReads, 1);
enabled = false;
assert.equal((await route.GET(request("action=list", allowedHeaders))).status, 503);
assert.equal((await (await route.GET(request("action=status"))).json()).configured, false);
console.log("Shared memory: fixed read-only endpoints, server credentials, session renewal, validation and private route gate passed.");
