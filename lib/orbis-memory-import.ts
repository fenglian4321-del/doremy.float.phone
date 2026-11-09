/** Verified against fenglian4321-del/Orbis OrbisMemoryRepository.export + OrbisMemoryNote DTO. */
export type OrbisMemoryNote = {
    id: string; assistantId: string; body: string; summary: string;
    state: "static" | "conditional" | "pinned" | "paused"; previousState: "static" | "conditional" | "pinned";
    tags: string[]; keywords: string[]; important: boolean; minIntervalTurns: number;
    createdAt: number; updatedAt: number; revision: number; deleted: boolean;
};
export type OrbisImportPreview = { assistantId: string; ignoredRevisions: number; entries: { note: OrbisMemoryNote; error?: string }[] };
const fields = ["id", "assistantId", "body", "summary", "state", "previousState", "tags", "keywords", "important", "minIntervalTurns", "createdAt", "updatedAt", "revision", "deleted"];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function validateOrbisNote(raw: unknown, assistantId: string): { note: OrbisMemoryNote; error?: string } {
    const record = object(raw) ? raw : {};
    const note = { summary: "", state: "static", previousState: "static", tags: [], keywords: [], important: false, minIntervalTurns: 0, revision: 1, deleted: false, ...record } as unknown as OrbisMemoryNote;
    const failed = (error: string) => ({ note, error });
    if (!object(raw) || Object.keys(raw).some(key => !fields.includes(key))) return failed("不是受支持的 Orbis 记忆条目，或含未知字段");
    if (typeof note.id !== "string" || !note.id || note.id.length > 160 || /[\x00-\x1f]/.test(note.id) || note.assistantId !== assistantId) return failed("来源标识无效或不属于本文件的助手");
    if (typeof note.body !== "string" || !note.body.trim() || note.body.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(note.body)) return failed("正文超出 12000 字符容量或含危险控制字符；不会截断");
    if (!["static", "conditional", "pinned", "paused"].includes(note.state) || !["static", "conditional", "pinned"].includes(note.previousState) || typeof note.summary !== "string") return failed("原记忆状态或摘要无效");
    if (typeof note.deleted !== "boolean" || typeof note.important !== "boolean") return failed("原记忆标记无效");
    if (note.deleted) return failed("原库已删除，不导入");
    for (const key of ["createdAt", "updatedAt", "revision", "minIntervalTurns"] as const) if (!Number.isSafeInteger(note[key]) || note[key] < 0 || note[key] > 8_640_000_000_000_000) return failed("时间、版本或间隔无效");
    if (note.revision < 1) return failed("原版本无效");
    for (const key of ["tags", "keywords"] as const) if (!Array.isArray(note[key]) || note[key].length > 32 || note[key].some(item => typeof item !== "string" || item.length > 80 || /[\x00-\x1f]/.test(item))) return failed("标签或关键词超出容量；不会截断");
    const metadata = Object.fromEntries(Object.entries(note).filter(([key]) => key !== "body"));
    if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > 3000) return failed("来源元数据超过当前容量；不会截断");
    return { note };
}
export function parseOrbisMemoryExport(text: string): OrbisImportPreview {
    if (new TextEncoder().encode(text).byteLength > 20 * 1024 * 1024) throw new Error("文件超过当前 20MB 预览容量，未上传。");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error("不是有效的 JSON 记忆导出，未上传。"); }
    if (!object(raw) || raw.schema !== "orbis_memory_export_v1" || Object.keys(raw).some(key => !["schema", "assistantId", "notes", "revisions"].includes(key))
        || typeof raw.assistantId !== "string" || !raw.assistantId || raw.assistantId.length > 160 || !Array.isArray(raw.notes) || !Array.isArray(raw.revisions)) throw new Error("只支持 Orbis 的独立记忆导出 orbis_memory_export_v1，不能选择完整聊天备份。");
    if (raw.notes.length > 1000) throw new Error("每次最多预览 1000 条当前记忆，未上传。");
    const ids = raw.notes.filter(object).map(note => note.id);
    if (ids.length !== new Set(ids).size) throw new Error("当前条目出现重复 ID，无法确定版本，未上传。");
    return { assistantId: raw.assistantId, ignoredRevisions: raw.revisions.length, entries: raw.notes.map(note => validateOrbisNote(note, raw.assistantId as string)) };
}
