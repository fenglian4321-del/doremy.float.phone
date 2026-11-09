import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";
import type { TokenUsage } from "./token-usage";
export const USAGE_REASON_LABELS = {
    chat: "普通回复 / 首轮决策", group_reply: "群聊回复 / 首轮决策", tool_continuation: "工具结果后的续写", resume: "用户恢复未完成任务",
    offline_reply: "线下模式回复（模型请求）", offline_summary_retry: "线下模式缺摘要后的补提",
    manual_compression: "手动续聊压缩", manual_memory: "手动记忆整理", auxiliary: "辅助生成（具体功能未标注）",
    embedding: "向量请求", retry: "明确重试", tool_execution: "工具执行（非模型）", unknown: "未标注 / 历史记录",
} as const;
export type UsageReason = keyof typeof USAGE_REASON_LABELS;

export type UsageContext = {
    provider: string; model: string; configId?: string;
    source: "chat" | "background" | "embedding" | "qa" | "tool" | "work" | "private";
    scopeId?: string;
    reason?: UsageReason;
};
export type UsageLedgerEntry = UsageContext & {
    id: string; at: string; status: "pending" | "completed" | "error" | "cancelled";
    usage?: TokenUsage; durationMs?: number; httpStatus?: number;
};
const KEY = "float_private_usage_ledger_v1";
const MAX_ROWS = 20_000;
export const USAGE_RETENTION_DAYS = 90;
registerKvMigration(KEY);
let generation = 0;
const safeText = (value: unknown, fallback: string) => typeof value === "string" && value.length <= 160
    && !/[\x00-\x1f]|https?:\/\/|bearer\s|\bsk-/i.test(value) ? value : fallback;
const opaque = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function usageFields(usage?: TokenUsage): TokenUsage | undefined {
    if (!usage) return undefined;
    const selected: TokenUsage = {};
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "reasoning_tokens", "cache_creation_tokens"] as const) {
        if (count(usage[key])) selected[key] = usage[key];
    }
    return Object.keys(selected).length ? selected : undefined;
}
function clean(entry: UsageLedgerEntry): UsageLedgerEntry {
    return { id: opaque(entry.id) ?? "invalid", at: entry.at,
        provider: safeText(entry.provider, "Custom"), model: safeText(entry.model, "unknown"), configId: opaque(entry.configId), scopeId: opaque(entry.scopeId),
        source: ["chat", "background", "embedding", "qa", "tool", "work", "private"].includes(entry.source) ? entry.source : "chat",
        reason: entry.reason && Object.prototype.hasOwnProperty.call(USAGE_REASON_LABELS, entry.reason) ? entry.reason : "unknown",
        status: ["pending", "completed", "error", "cancelled"].includes(entry.status) ? entry.status : "error",
        usage: usageFields(entry.usage), durationMs: count(entry.durationMs) ? entry.durationMs : undefined,
        httpStatus: count(entry.httpStatus) && entry.httpStatus <= 599 ? entry.httpStatus : undefined };
}
export function getUsageLedger(): UsageLedgerEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw: unknown = JSON.parse(kvGet(KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        const since = Date.now() - USAGE_RETENTION_DAYS * 86_400_000;
        return raw.filter(row => row && typeof row === "object" && typeof row.at === "string" && Number.isFinite(Date.parse(row.at)) && Date.parse(row.at) >= since && Date.parse(row.at) <= Date.now() + 300_000)
            .slice(-MAX_ROWS).map(clean);
    } catch { return []; }
}
function save(entry: UsageLedgerEntry) {
    if (typeof window === "undefined") return;
    try {
        const rows = getUsageLedger();
        const index = rows.findIndex(row => row.id === entry.id);
        if (index >= 0) rows[index] = clean(entry); else rows.push(clean(entry));
        kvSet(KEY, JSON.stringify(rows.slice(-MAX_ROWS)));
        window.dispatchEvent(new Event("float-usage-ledger-updated"));
    } catch { /* Accounting must not interrupt an API request. */ }
}
export function clearUsageLedger() { if (typeof window !== "undefined") { generation++; kvRemove(KEY); window.dispatchEvent(new Event("float-usage-ledger-updated")); } }
export function beginUsageRequest(context: UsageContext) {
    const started = Date.now();
    const currentGeneration = generation;
    const entry: UsageLedgerEntry = { ...context, id: typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${started}-${Math.random().toString(36).slice(2)}`, at: new Date(started).toISOString(), status: "pending" };
    save(entry);
    let finished = false;
    return (status: Exclude<UsageLedgerEntry["status"], "pending">, usage?: TokenUsage, httpStatus?: number) => {
        if (finished || currentGeneration !== generation) return;
        finished = true;
        save({ ...entry, status, usage, httpStatus, durationMs: Math.max(0, Date.now() - started) });
    };
}
export function summarizeUsage(rows: UsageLedgerEntry[]) {
    const modelRows = rows.filter(row => row.source !== "tool");
    const fields = ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "reasoning_tokens", "cache_creation_tokens"] as const;
    const reported = Object.fromEntries(fields.map(key => [key, modelRows.filter(row => row.usage?.[key] !== undefined).length])) as Record<typeof fields[number], number>;
    const totals = Object.fromEntries(fields.map(key => [key, modelRows.reduce((sum, row) => sum + (row.usage?.[key] ?? 0), 0)])) as Record<typeof fields[number], number>;
    const cacheRows = modelRows.filter(row => row.usage?.prompt_tokens !== undefined && row.usage.cached_tokens !== undefined && row.usage.cached_tokens <= row.usage.prompt_tokens);
    const cacheInput = cacheRows.reduce((sum, row) => sum + row.usage!.prompt_tokens!, 0);
    return { totals, reported, requests: rows.length, modelRequests: modelRows.length, toolRequests: rows.length - modelRows.length, unknown: modelRows.filter(row => !row.usage).length,
        pending: rows.filter(row => row.status === "pending").length, errors: rows.filter(row => row.status === "error" || row.status === "cancelled").length,
        cacheCoverage: cacheRows.length, cacheHitRate: cacheInput ? cacheRows.reduce((sum, row) => sum + row.usage!.cached_tokens!, 0) / cacheInput : undefined };
}
