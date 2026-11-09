import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
const env = { FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN: "https://float.example" };
function load(path, mocks = {}) {
    const module = { exports: {} };
    const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(compiled, { module, exports: module.exports, require: n => mocks[n] ?? require(n),
        process: { env }, URL, URLSearchParams, Request, Response, AbortSignal, TextDecoder, Date });
    return module.exports;
}
const api = load("../lib/server/shared-memory.ts");
const internal = "http://0.0.0.0:3001/api/shared-memory";
const config = { baseUrl: "http://ombre:8000", password: "synthetic", accessToken: "a".repeat(64) };
const route = load("../app/api/shared-memory/route.ts", {
    "next/server": { NextResponse: { json: (data, options) => Response.json(data, options) } },
    "@/lib/server/shared-memory": { ...api, readSharedMemoryConfig: () => config },
    "@/lib/server/shared-memory-review": { createOmbreReviewClient: () => ({}) },
});
const post = (origin, more = {}) => new Request(internal, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", "x-float-memory-access-token": config.accessToken, ...more,
}, body: JSON.stringify({ action: "connect" }) });
const valid = await route.POST(post("https://float.example"));
assert.equal(valid.status, 200);
assert.match(valid.headers.get("set-cookie"), /; Secure/);
assert.match(valid.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
assert.equal((await route.POST(post("https://evil.example", { "x-forwarded-host": "float.example", "x-forwarded-proto": "https" }))).status, 403);
assert.equal((await route.POST(post("https://float.example", { "sec-fetch-site": "cross-site" }))).status, 403);
assert.equal((await route.POST(post("http://0.0.0.0:3001"))).status, 403);
const cookie = valid.headers.get("set-cookie").split(";")[0];
assert.equal(api.authorizeSharedMemory(new Request(internal, { headers: { cookie } }), config), true);
assert.equal(api.sharedMemoryRequestOrigin(new Request(internal), {}), "http://0.0.0.0:3001");
for (const invalid of ["http://public.example", "https://user:pass@float.example", "https://float.example/mcp", "https://float.example?q=1", "bad-url"]) {
    assert.throws(() => api.sharedMemoryRequestOrigin(new Request(internal), { FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN: invalid }), /公网地址/);
}
env.FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN = "https://float.example/path";
assert.equal((await route.POST(post("https://float.example"))).status, 503);
console.log("Reverse-proxy public origin: valid login, Secure cookie, cross-site/spoofed-header rejection and fail-closed configuration passed.");
