"use client";

import { useEffect, useRef, useState } from "react";
import { FileInput, Undo2 } from "lucide-react";
import { parseOrbisMemoryExport, type OrbisImportPreview } from "@/lib/orbis-memory-import";
import type { SharedMemoryImportBatch, SharedMemoryImportReceipt, SharedMemoryImportRollback } from "@/lib/shared-memory-types";
import styles from "./shared-memory.module.css";

export type OrbisImportReply = { importReceipt?: SharedMemoryImportReceipt; batches?: SharedMemoryImportBatch[]; results?: SharedMemoryImportRollback[]; nextCursor?: string | null };
export function OrbisMemoryImportPanel({ request, busy, onChanged }: {
    request: (action: string, payload?: Record<string, unknown>) => Promise<OrbisImportReply | null>;
    busy: boolean; onChanged: () => void;
}) {
    const [preview, setPreview] = useState<OrbisImportPreview | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [receipts, setReceipts] = useState<Record<string, string>>({});
    const [batchId, setBatchId] = useState("");
    const [batches, setBatches] = useState<SharedMemoryImportBatch[]>([]);
    const [confirmed, setConfirmed] = useState(false);
    const [confirmUndo, setConfirmUndo] = useState("");
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [visible, setVisible] = useState(30);
    const [loaded, setLoaded] = useState(false);
    const generation = useRef(0);
    const stop = useRef(false);
    useEffect(() => () => { generation.current++; stop.current = true; }, []);
    const loadBatches = async () => {
        const current = generation.current;
        const reply = await request("review_import_batches");
        if (reply && current === generation.current) { setBatches(reply.batches ?? []); setLoaded(true); }
    };
    const readFile = async (file?: File) => {
        if (!file) return;
        const current = ++generation.current;
        setError(""); setNotice(""); setPreview(null); setSelected(new Set()); setConfirmed(false); setReceipts({}); setVisible(30);
        if (file.size > 20 * 1024 * 1024) { setError("文件超过当前 20MB 预览容量，未上传。"); return; }
        try {
            const value = parseOrbisMemoryExport(await file.text());
            if (current !== generation.current) return;
            setPreview(value); setSelected(new Set(value.entries.filter(item => !item.error).map(item => item.note.id))); setBatchId(crypto.randomUUID());
        } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "不能读取记忆导出。"); }
    };
    const runImport = async () => {
        if (!preview || !confirmed) return;
        const current = generation.current;
        stop.current = false; setRunning(true); setError(""); setNotice("");
        let changed = false, failed = false;
        for (const item of preview.entries) {
            if (stop.current || current !== generation.current) break;
            if (item.error || !selected.has(item.note.id) || ["created", "existing"].includes(receipts[item.note.id])) continue;
            const reply = await request("review_import_note", { batchId, note: item.note });
            if (current !== generation.current) return;
            if (!reply?.importReceipt) { setReceipts(previous => ({ ...previous, [item.note.id]: "unconfirmed" })); failed = true; break; }
            setReceipts(previous => ({ ...previous, [item.note.id]: reply.importReceipt!.state })); changed = true;
        }
        if (current !== generation.current) return;
        setRunning(false);
        setNotice(failed ? "此条未导入或结果未确认，已停止后续条目。请核对上方原因；重新导入会恢复同一条目的操作，不会覆盖后续人工修改。" : stop.current ? "已停止后续导入，已完成的条目仍保留。" : "已处理所选条目；已存在的记忆保留原样。原库静态和暂停条目不自动召回。");
        if (!failed) await loadBatches();
        if (changed) onChanged();
    };
    const undoBatch = async (id: string) => {
        const current = generation.current;
        setRunning(true); setNotice(""); setError(""); stop.current = false;
        let cursor: string | undefined, removed = 0, kept = 0, review = 0, failed = false;
        const seen = new Set<string>();
        for (let step = 0; step < 50; step++) {
            if (stop.current || current !== generation.current) break;
            const reply = await request("review_import_rollback", { batchId: id, ...(cursor ? { cursor } : {}) });
            if (current !== generation.current) return;
            if (!reply?.results) { failed = true; break; }
            for (const row of reply.results) { if (row.state === "rolled_back") removed++; else if (row.state === "kept_existing") kept++; else review++; }
            if (!reply.nextCursor) break;
            if (seen.has(reply.nextCursor)) { setError("批次游标异常，已停止；可刷新核对，未覆盖当前记忆。"); failed = true; break; }
            seen.add(reply.nextCursor); cursor = reply.nextCursor;
            if (step === 49) failed = true;
        }
        if (current !== generation.current) return;
        setRunning(false); setConfirmUndo("");
        setNotice(`本次核对：移入回收站/已撤销 ${removed} 条，保留原有 ${kept} 条，需人工核对 ${review} 条。${failed || stop.current ? "处理未全部确认，可再次恢复核对。" : ""}`);
        if (!failed) await loadBatches(); onChanged();
    };
    return <details className={styles.fold} onToggle={event => { if (event.currentTarget.open && !loaded && !running) void loadBatches(); }}>
        <summary><FileInput size={13} aria-hidden="true" />导入 Orbis 记忆</summary>
        <p className={styles.muted}>仅支持 Orbis 的独立记忆导出 orbis_memory_export_v1，不读取完整聊天备份。选择文件后先在本机预览，点击导入才上传选中的当前条目。</p>
        <input type="file" accept="application/json,.json" aria-label="选择 Orbis 记忆导出文件" disabled={busy || running} onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ""; }} className={styles.usageSelect} />
        {error && <p role="alert" className={styles.alert}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
        {preview && <>
            <p className={styles.muted}>当前条目 {preview.entries.length} 条，跳过 {preview.ignoredRevisions} 条历史版本。正文不截断；首尾空白按 Markdown 规则规范化，完整原文保留在导入记录。标签、摘要、原时间、状态和版本作为来源保留。Orbis 的条件触发、间隔不直接继承，召回按 Ombre 规则处理。</p>
            <button type="button" className={styles.button} disabled={busy || running} onClick={() => setSelected(new Set(preview.entries.filter(item => !item.error).map(item => item.note.id)))}>选择全部可导入条目</button>
            <button type="button" className={styles.quiet} disabled={busy || running} onClick={() => setSelected(new Set())}>清空选择</button>
            {preview.entries.slice(0, visible).map((item, index) => <article className={styles.draft} key={index}>
                <label className={styles.setting}><input type="checkbox" aria-label={`选择 Orbis 条目 ${index + 1}`} disabled={busy || running || !!item.error} checked={selected.has(item.note.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.note.id); else next.delete(item.note.id); return next; })} /><span>记忆 {index + 1}<small>{item.error || `${item.note.state === "static" || item.note.state === "paused" ? "仅保存，不自动召回" : item.note.state === "pinned" ? "核心记忆" : "普通记忆"} · 原版本 ${item.note.revision}`}</small></span></label>
                <p className={styles.preview}>{typeof item.note.body === "string" ? item.note.body : "正文无效"}</p>
                <details className={styles.fold}><summary>查看完整原文与来源字段</summary><pre className={styles.code}>{JSON.stringify(item.note, null, 2)}</pre></details>
                {receipts[item.note.id] && <p className={styles.muted}>{receipts[item.note.id] === "created" ? "已导入" : receipts[item.note.id] === "existing" ? "已存在，保留当前记忆" : "未导入或结果未确认，请核对后重试"}</p>}
            </article>)}
            {preview.entries.length > visible && <button type="button" className={styles.button} onClick={() => setVisible(count => count + 30)}>再显示 30 条</button>}
            <label className={styles.setting}><input type="checkbox" aria-label="确认将已选记忆导入共享库" checked={confirmed} disabled={running} onChange={event => setConfirmed(event.target.checked)} /><span>确认将已选记忆导入 VPS 共享库<small>所有连接设备和本设备所有角色共用，不会仅限原 Orbis 助手。</small></span></label>
            <button type="button" className={styles.primary} disabled={busy || running || !confirmed || !selected.size} onClick={() => void runImport()}>导入已选 {selected.size} 条记忆</button>
        </>}
        {running && <button type="button" className={styles.button} onClick={() => { stop.current = true; }}>停止后续操作</button>}
        <h3 className={styles.sectionTitle} style={{ marginTop: 18 }}>导入批次</h3>
        {batches.map(batch => <div className={styles.draft} key={batch.id}><p className={styles.muted}>{new Date(batch.at).toLocaleString("zh-CN")} · 共 {batch.total} 条 · 新建 {batch.created} · 已撤销 {batch.undone} · 未决 {batch.pending}</p>
            <button type="button" className={styles.button} disabled={busy || running} onClick={() => setConfirmUndo(batch.id)}><Undo2 size={12} aria-hidden="true" />撤销这批导入</button>
            {confirmUndo === batch.id && <div className={styles.draft}><p className={styles.muted}>仅将本批新建且此后未修改的记忆移入回收站。已有条目和导入后的人工修改都会保留。</p><button type="button" className={styles.danger} disabled={busy || running} onClick={() => void undoBatch(batch.id)}>确认撤销此批导入</button><button type="button" className={styles.quiet} onClick={() => setConfirmUndo("")}>取消</button></div>}
        </div>)}
        {loaded && !batches.length && <p className={styles.muted}>暂无经本入口记录的导入批次。</p>}
        <button type="button" className={styles.quiet} disabled={busy || running} onClick={() => void loadBatches()}>刷新导入批次</button>
    </details>;
}
