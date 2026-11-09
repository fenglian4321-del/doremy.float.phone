import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SharedMemoryDetail, SharedMemorySummary } from "../shared-memory-types";

export type SharedMemoryConfig = { baseUrl: string; password: string; accessToken: string; reviewToken?: string };

export class SharedMemoryError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 502) {
        super(message);
    }
}

export function readSharedMemoryConfig(env: NodeJS.ProcessEnv = process.env): SharedMemoryConfig | null {
    const baseUrl = env.FLOAT_SHARED_MEMORY_OMBRE_URL?.trim();
    const password = env.FLOAT_SHARED_MEMORY_OMBRE_PASSWORD;
    const accessToken = env.FLOAT_SHARED_MEMORY_ACCESS_TOKEN?.trim();
    if (!baseUrl || !password || !accessToken) return null;
    let url: URL;
    try { url = new URL(baseUrl); } catch {
        throw new SharedMemoryError("configuration", "共享记忆服务端地址配置无效。", 503);
    }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && env.FLOAT_SHARED_MEMORY_ALLOW_HTTP === "true"))
        || url.username || url.password || url.search || url.hash || url.pathname !== "/"
        || accessToken.length < 32 || accessToken.length > 512 || accessToken === password) {
        throw new SharedMemoryError("configuration", "共享记忆服务端配置无效，请检查地址与独立访问口令。", 503);
    }
    const reviewToken = env.FLOAT_SHARED_MEMORY_REVIEW_TOKEN?.trim() || undefined;
    if (reviewToken && (reviewToken.length < 32 || reviewToken.length > 512 || reviewToken === accessToken || reviewToken === password)) {
        throw new SharedMemoryError("configuration", "共享审核服务凭据配置无效。", 503);
    }
    return { baseUrl: url.origin, password, accessToken, reviewToken };
}

const OWNER_COOKIE = "float_memory_owner";
const SESSION_MS = 7 * 24 * 60 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest();
const signature = (payload: string, config: SharedMemoryConfig) => createHmac("sha256", JSON.stringify([config.baseUrl, config.accessToken, config.reviewToken ?? ""]))
    .update(`float-memory-owner-v1\n${payload}`).digest("hex");

/** Standalone servers can receive an internal request URL behind a reverse proxy.
 * Only trust an operator-configured public origin, never arbitrary forwarded headers.
 */
export function sharedMemoryRequestOrigin(request: Request, env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.FLOAT_SHARED_MEMORY_PUBLIC_ORIGIN?.trim();
    if (!configured) return new URL(request.url).origin;
    let url: URL;
    try { url = new URL(configured); } catch {
        throw new SharedMemoryError("configuration", "共享记忆公网地址配置无效。", 503);
    }
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new SharedMemoryError("configuration", "共享记忆公网地址需为 HTTPS 站点根地址。", 503);
    }
    return url.origin;
}

export function sharedMemorySessionCookie(request: Request, config: SharedMemoryConfig, clear = false): string {
    const payload = `${Date.now() + SESSION_MS}.${randomBytes(16).toString("hex")}`;
    const value = clear ? "" : `${payload}.${signature(payload, config)}`;
    return `${OWNER_COOKIE}=${value}; Path=/api/shared-memory; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${sharedMemoryRequestOrigin(request).startsWith("https:") ? "; Secure" : ""}`;
}

export function authorizeSharedMemory(request: Request, config: SharedMemoryConfig, headerOnly = false): boolean {
    const token = request.headers.get("x-float-memory-access-token") ?? "";
    if (token) return token.length <= 512 && timingSafeEqual(digest(token), digest(config.accessToken));
    if (headerOnly) return false;
    const value = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1);
    if (!value || value.length > 256) return false;
    const match = /^(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
    if (!match) return false;
    const expires = Number(match[1]);
    if (expires <= Date.now() || expires > Date.now() + SESSION_MS) return false;
    return timingSafeEqual(digest(match[3]), digest(signature(`${match[1]}.${match[2]}`, config)));
}

const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(value) && value !== "." && value !== "..";

export function validateSharedMemoryId(id: string): void {
    if (!validId(id)) throw new SharedMemoryError("invalid_id", "记忆 ID 无效。", 400);
}

export async function readSharedMemoryJson(response: Response): Promise<unknown> {
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        throw new SharedMemoryError("protocol", "共享记忆服务返回了不支持的格式。");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SharedMemoryError("protocol", "共享记忆服务返回了空响应。");
    const decoder = new TextDecoder();
    let size = 0;
    let body = "";
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 4 * 1024 * 1024) {
                await reader.cancel();
                throw new SharedMemoryError("too_large", "共享记忆响应超过本次读取上限，请缩小搜索范围。");
            }
            body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
    } finally { reader.releaseLock(); }
    try { return JSON.parse(body); } catch {
        throw new SharedMemoryError("protocol", "共享记忆服务返回了无效数据。");
    }
}

function summaries(value: unknown): SharedMemorySummary[] {
    if (!Array.isArray(value)) throw new SharedMemoryError("protocol", "共享记忆列表格式与适配版本不一致。");
    return value.map(item => {
        const row = object(item);
        if (!row || !validId(row.id) || typeof row.content_preview !== "string") {
            throw new SharedMemoryError("protocol", "共享记忆条目格式与适配版本不一致。");
        }
        return {
            id: row.id, name: text(row.name) || row.id, preview: row.content_preview,
            type: text(row.type), tags: strings(row.tags), domains: strings(row.domain),
            createdAt: text(row.created), lastActiveAt: text(row.last_active),
            dontSurface: typeof row.dont_surface === "boolean" ? row.dont_surface : undefined,
        };
    });
}

/** Server-only, fixed endpoint adapter for xinchao-nian's vendored OB dashboard API.
 * No arbitrary paths, browser credentials, remote errors or session cookies escape this boundary.
 */
export function createOmbreReader(config: SharedMemoryConfig, fetcher: typeof fetch = fetch) {
    let cookie = "";
    let expiresAt = 0;
    let loginPending: Promise<void> | undefined;

    async function remote(path: string, init: RequestInit = {}): Promise<Response> {
        try {
            return await fetcher(`${config.baseUrl}${path}`, {
                ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000),
            });
        } catch {
            throw new SharedMemoryError("unreachable", "无法读取共享记忆服务，请检查连接后重试。");
        }
    }

    async function login(): Promise<void> {
        if (cookie && Date.now() < expiresAt) return;
        if (!loginPending) {
            loginPending = (async () => {
                const response = await remote("/auth/login", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ password: config.password }),
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new SharedMemoryError("upstream_auth", "Ombre 登录失败，请检查服务端凭据或稍后重试。");
                }
                const session = /(?:^|[,;]\s*)ombre_session=([A-Za-z0-9_-]{1,256})(?:;|$)/.exec(response.headers.get("set-cookie") ?? "");
                await response.body?.cancel();
                if (!session) throw new SharedMemoryError("protocol", "Ombre 未返回预期会话，当前版本尚未适配。");
                cookie = `ombre_session=${session[1]}`;
                expiresAt = Date.now() + 15 * 60_000;
            })().finally(() => { loginPending = undefined; });
        }
        await loginPending;
    }

    async function get(path: string): Promise<unknown> {
        await login();
        const usedCookie = cookie;
        let response = await remote(path, { headers: { Cookie: usedCookie } });
        if (response.status === 401) {
            await response.body?.cancel();
            // One renewal only; another request may already have renewed the session.
            if (cookie === usedCookie) { cookie = ""; expiresAt = 0; }
            await login();
            response = await remote(path, { headers: { Cookie: cookie } });
        }
        if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 404) throw new SharedMemoryError("not_found", "这条共享记忆不存在或已移除。", 404);
            throw new SharedMemoryError("upstream", "共享记忆服务读取失败，请稍后重试。");
        }
        return readSharedMemoryJson(response);
    }

    return {
        async list(): Promise<SharedMemorySummary[]> { return summaries(await get("/api/buckets")); },
        async search(query: string): Promise<SharedMemorySummary[]> {
            if (!query.trim() || query.length > 500) throw new SharedMemoryError("invalid_query", "搜索词需为 1–500 个字符。", 400);
            return summaries(await get(`/api/search?q=${encodeURIComponent(query)}`));
        },
        async detail(id: string): Promise<SharedMemoryDetail> {
            validateSharedMemoryId(id);
            const row = object(await get(`/api/bucket/${encodeURIComponent(id)}`));
            const metadata = object(row?.metadata);
            if (!row || row.id !== id || typeof row.content !== "string" || !metadata) {
                throw new SharedMemoryError("protocol", "共享记忆详情格式与适配版本不一致。");
            }
            if (metadata.deleted_at) throw new SharedMemoryError("not_found", "这条共享记忆已移除。", 404);
            return { id, content: row.content, metadata };
        },
    };
}

let active: { signature: string; reader: ReturnType<typeof createOmbreReader> } | undefined;
export function getOmbreReader(config: SharedMemoryConfig) {
    const signature = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    if (!active || active.signature !== signature) active = { signature, reader: createOmbreReader(config) };
    return active.reader;
}
