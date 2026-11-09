import { NextResponse } from "next/server";
import { authorizeSharedMemory, getOmbreReader, readSharedMemoryConfig, sharedMemoryRequestOrigin, sharedMemorySessionCookie, SharedMemoryError } from "@/lib/server/shared-memory";
import { createOmbreReviewClient } from "@/lib/server/shared-memory-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store", "Vary": "x-float-memory-access-token, Cookie", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
    try {
        // A separate high-entropy gate also protects deployments in self-hosted mode,
        // where Float intentionally skips its official account login.
        const origin = request.headers.get("origin");
        if ((origin && origin !== sharedMemoryRequestOrigin(request)) || request.headers.get("sec-fetch-site") === "cross-site") {
            return NextResponse.json({ ok: false, error: "不允许跨站读取共享记忆。" }, { status: 403, headers });
        }
        const config = readSharedMemoryConfig();
        const params = new URL(request.url).searchParams;
        const action = params.get("action") ?? "status";
        if (action === "status") {
            return NextResponse.json({ ok: true, configured: Boolean(config), authorized: config ? authorizeSharedMemory(request, config) : false, latent: false }, { headers });
        }
        if (!config) throw new SharedMemoryError("unconfigured", "共享记忆服务尚未配置。", 503);
        if (!authorizeSharedMemory(request, config)) throw new SharedMemoryError("unauthorized", "共享记忆访问口令不正确或已失效。", 401);
        const reader = getOmbreReader(config);
        const review = createOmbreReviewClient(config);
        let data;
        if (action === "list") data = { entries: await reader.list() };
        else if (action === "search") data = { entries: await reader.search(params.get("q") ?? "") };
        else if (action === "detail") data = { entry: await reader.detail(params.get("id") ?? "") };
        else if (action === "review_status") data = { review: await review.status() };
        else if (action === "review_candidates") data = await review.candidates();
        else if (action === "review_detail") data = { entry: await review.detail(params.get("id") ?? "") };
        else if (action === "review_history") data = { history: await review.history(params.get("id") ?? "") };
        else if (action === "review_memories") data = { entries: await review.memories(params.get("q")?.trim() || undefined, params.get("engine") ?? "ombre") };
        else if (action === "review_catalog") data = await review.catalog(params.get("state") ?? "active", params.get("cursor") || undefined);
        else if (action === "review_import_batches") data = await review.importBatches();
        else throw new SharedMemoryError("invalid_action", "不支持的共享记忆操作。", 400);
        return NextResponse.json({ ok: true, ...data, fetchedAt: new Date().toISOString() }, { headers });
    } catch (error) {
        const known = error instanceof SharedMemoryError;
        return NextResponse.json({ ok: false, code: known ? error.code : "internal", error: known ? error.message : "共享记忆读取失败。" }, {
            status: known ? error.status : 500, headers,
        });
    }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader();
    if (!reader) throw new SharedMemoryError("invalid_request", "请求内容为空。", 400);
    let size = 0;
    let raw = "";
    const decoder = new TextDecoder();
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 64 * 1024) { await reader.cancel(); throw new SharedMemoryError("too_large", "审核请求过大。", 413); }
            raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new SharedMemoryError("invalid_request", "审核请求不是有效 JSON。", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SharedMemoryError("invalid_request", "审核请求格式无效。", 400);
    return body as Record<string, unknown>;
}

export async function POST(request: Request) {
    try {
        if (request.headers.get("origin") !== sharedMemoryRequestOrigin(request) || request.headers.get("sec-fetch-site") === "cross-site") {
            return NextResponse.json({ ok: false, error: "审核操作只允许从本站发起。" }, { status: 403, headers });
        }
        const config = readSharedMemoryConfig();
        if (!config) throw new SharedMemoryError("unconfigured", "共享记忆服务尚未配置。", 503);
        if (!authorizeSharedMemory(request, config)) throw new SharedMemoryError("unauthorized", "共享记忆访问口令不正确或已失效。", 401);
        const { action, ...payload } = await readBody(request);
        if (action === "connect") {
            if (!authorizeSharedMemory(request, config, true)) throw new SharedMemoryError("unauthorized", "请输入共享记忆访问口令。", 401);
            return NextResponse.json({ ok: true }, { headers: { ...headers, "Set-Cookie": sharedMemorySessionCookie(request, config) } });
        }
        if (action === "disconnect") {
            return NextResponse.json({ ok: true }, { headers: { ...headers, "Set-Cookie": sharedMemorySessionCookie(request, config, true) } });
        }
        if (typeof action !== "string" || !action.startsWith("review_")) throw new SharedMemoryError("invalid_action", "不支持的共享审核操作。", 400);
        const result = await createOmbreReviewClient(config).mutate(action.slice(7), payload);
        return NextResponse.json({ ok: true, ...result }, { headers });
    } catch (error) {
        const known = error instanceof SharedMemoryError;
        return NextResponse.json({ ok: false, code: known ? error.code : "internal", error: known ? error.message : "共享审核操作失败，请刷新核对同一记录。" }, {
            status: known ? error.status : 500, headers,
        });
    }
}
