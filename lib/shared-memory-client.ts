import type { MemoryEntry } from "./memory-types";
import type { SharedMemoryCandidate, SharedMemoryPolicy, SharedMemoryReviewDetail } from "./shared-memory-types";

export type MemorySaveResult = { state: "saved" | "pending"; entry?: MemoryEntry };
let lastFailureNoticeAt = 0;
function reportReadFailure(action: string) {
    if (action !== "review_memories" || typeof window === "undefined" || Date.now() - lastFailureNoticeAt < 60_000) return;
    lastFailureNoticeAt = Date.now();
    window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind: "error", message: "共享记忆暂时无法访问，请到记忆库检查连接。本次没有使用本机旧库替代。" } }));
}

async function request(action: string, body?: Record<string, unknown>, params?: Record<string, string>) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
        const query = new URLSearchParams({ action, ...params });
        let response: Response;
        try { response = await fetch(body ? "/api/shared-memory" : `/api/shared-memory?${query}`, {
            method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
            signal: controller.signal,
            headers: body ? { "Content-Type": "application/json" } : {},
            body: body ? JSON.stringify({ action, ...body }) : undefined,
        }); } catch { reportReadFailure(action); throw new Error("共享记忆连接失败，没有转存或回退本机记忆。"); }
        let data: { ok: boolean; error?: string; entries?: SharedMemoryReviewDetail[]; entry?: SharedMemoryReviewDetail; candidate?: SharedMemoryCandidate; review?: { available: boolean; policy?: SharedMemoryPolicy } };
        try { data = await response.json(); } catch { reportReadFailure(action); throw new Error("共享记忆返回格式异常，没有使用本机旧库。"); }
        if (!response.ok || !data.ok) { reportReadFailure(action); throw new Error(data.error || "共享记忆不可用；没有改写或回退到本机记忆库。"); }
        return data;
    } finally { clearTimeout(timeout); }
}

export async function ensureSharedMemoryWritesAllowed(): Promise<void> {
    const data = await request("review_status");
    if (!data.review?.available) throw new Error("共享记忆写入服务未就绪，未调用记忆整理模型。");
    if (data.review.policy?.paused) throw new Error("共享 AI 自动记忆已暂停，未调用记忆整理模型。");
}

function toMemoryEntry(entry: SharedMemoryReviewDetail, characterId: string): MemoryEntry {
    const source = entry.provenance ?? {};
    const metadata = source.entryMetadata && typeof source.entryMetadata === "object" && !Array.isArray(source.entryMetadata)
        ? source.entryMetadata as Record<string, unknown> : {};
    const importance = typeof entry.metadata.importance === "number" ? Math.max(0, Math.min(1, entry.metadata.importance / 10)) : 0.5;
    const orbis = metadata.orbis && typeof metadata.orbis === "object" ? metadata.orbis as Record<string, unknown> : {};
    const originalDate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000 ? new Date(value).toISOString() : "";
    return {
        id: `ombre:${entry.id}`, characterId, sourceApp: "chat",
        type: String(entry.metadata.type ?? "").trim().toLowerCase() === "permanent" ? "core" : "long_term", content: entry.content,
        importance, createdAt: source.client === "orbis_import" ? originalDate(orbis.createdAt) : typeof entry.metadata.created === "string" ? entry.metadata.created : "",
        updatedAt: entry.modifiedAt || originalDate(orbis.updatedAt),
        metadata: { ...metadata, sourceModule: "ombre", sharedCanonicalId: entry.id, sharedRevision: entry.revision,
            originalMetadata: entry.metadata, sharedProvenance: source },
    };
}

export async function loadSharedMemoryEntries(characterId: string, query?: string, engine: "ombre" | "latent" = "ombre"): Promise<MemoryEntry[]> {
    const data = await request("review_memories", undefined, query?.trim() ? { q: query.slice(-500), ...(engine === "latent" ? { engine } : {}) } : undefined);
    if (!Array.isArray(data.entries)) throw new Error("共享记忆返回格式无效；没有使用本机副本。");
    return data.entries.map(entry => toMemoryEntry(entry, characterId));
}

export async function noteSharedMemoryRecall(entries: MemoryEntry[]): Promise<void> {
    const ids = Array.from(new Set(entries.map(entry => entry.metadata?.sharedCanonicalId).filter((id): id is string => typeof id === "string")));
    for (let offset = 0; offset < ids.length; offset += 100) await request("review_recall", { ids: ids.slice(offset, offset + 100) });
}

export async function saveSharedMemoryEntry(entry: MemoryEntry, userInitiated = false): Promise<MemorySaveResult> {
    const canonicalId = entry.metadata?.sharedCanonicalId;
    const baseRevision = entry.metadata?.sharedRevision;
    const kind = typeof canonicalId === "string" ? "edit" : "create";
    if (kind === "edit" && typeof baseRevision !== "string") throw new Error("缺少共享记忆原版本，请刷新后编辑。");
    const selectedMetadata: Record<string, unknown> = {};
    for (const key of ["origin", "appId", "appName", "sessionId", "sourceSessionIds", "sourceChannel", "sourceDetail", "timeSpan", "eventDate", "active", "reason"]) {
        const value = entry.metadata?.[key];
        if (value !== undefined) selectedMetadata[key] = value;
    }
    const source = { client: "float", characterId: entry.characterId, localEntryId: entry.id,
        sourceApp: entry.sourceApp, memoryType: entry.type, importance: entry.importance,
        ...(entry.sourceMessageIds ? { sourceMessageIds: entry.sourceMessageIds } : {}), entryMetadata: selectedMetadata };
    const fingerprint = JSON.stringify([entry.id, entry.content, source, kind === "edit" ? baseRevision : ""]);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
    const clientKey = "float_" + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const data = await request(userInitiated ? "review_save" : "review_record", { clientKey, kind, content: entry.content, source,
        ...(kind === "edit" ? { targetId: canonicalId, baseRevision } : {}) });
    if (data.candidate?.state === "pending") return { state: "pending" };
    if (data.candidate?.state !== "approved") throw new Error("共享记忆写入尚未确认，请在可视化记忆库核对同一记录。");
    if (!userInitiated) return { state: "saved" };
    const saved = await request("review_detail", undefined, { id: data.candidate.targetId });
    return { state: "saved", entry: saved.entry ? toMemoryEntry(saved.entry, entry.characterId) : undefined };
}
