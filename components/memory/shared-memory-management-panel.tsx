"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import type { SharedMemoryManagedEntry, SharedMemoryManagementIntent, SharedMemoryManagementReceipt } from "@/lib/shared-memory-types";
import styles from "./shared-memory.module.css";

export type ManagementReply = { entries?: SharedMemoryManagedEntry[]; nextCursor?: string | null; pending?: SharedMemoryManagementIntent[]; management?: SharedMemoryManagementReceipt };
export function SharedMemoryManagementPanel({ request, busy, onChanged }: {
    request: (action: string, payload?: Record<string, unknown>, id?: string, params?: Record<string, string>) => Promise<ManagementReply | null>;
    busy: boolean; onChanged: () => void;
}) {
    const [mode, setMode] = useState<SharedMemoryManagedEntry["state"]>("active");
    const [entries, setEntries] = useState<SharedMemoryManagedEntry[]>([]);
    const [next, setNext] = useState<string | null>(null);
    const [pending, setPending] = useState<SharedMemoryManagementIntent[]>([]);
    const [intent, setIntent] = useState<SharedMemoryManagementIntent | null>(null);
    const [confirmation, setConfirmation] = useState<SharedMemoryManagedEntry | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [notice, setNotice] = useState("");
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const load = async (state = mode, cursor?: string) => {
        setMode(state); setConfirmation(null); setIntent(null);
        if (!cursor) { setEntries([]); setNext(null); }
        const reply = await request("review_catalog", undefined, undefined, { state, ...(cursor ? { cursor } : {}) });
        if (!reply || !mounted.current) return;
        setEntries(previous => cursor ? [...previous, ...(reply.entries ?? [])].filter((row, index, all) => all.findIndex(item => item.id === row.id) === index) : reply.entries ?? []);
        setNext(reply.nextCursor ?? null); setPending(reply.pending ?? []); setLoaded(true);
    };
    const submit = async (operation: SharedMemoryManagementIntent) => {
        setIntent(operation); setConfirmation(null); setNotice("");
        const reply = await request("review_manage", { ...operation });
        if (!reply || !mounted.current) return;
        if (reply.management?.state !== "completed") { setNotice("操作结果尚未确认，请恢复核对。"); return; }
        setNotice(operation.operation === "delete" ? "已移入回收站，停止自动召回。" : operation.operation === "archive" ? "已归档，停止自动召回。" : "已恢复；自动召回仍遵循原有可见性设置。");
        setIntent(null); await load(); onChanged();
    };
    const createIntent = (entry: SharedMemoryManagedEntry, operation: SharedMemoryManagementIntent["operation"]) => ({
        targetId: entry.id, operation, baseRevision: entry.revision, clientKey: crypto.randomUUID(),
    });
    return <details className={styles.fold} onToggle={event => { if (event.currentTarget.open && !loaded) void load(); }}>
        <summary><Archive size={13} aria-hidden="true" />整理与回收站</summary>
        <p className={styles.muted}>归档会保留原文并停止自动召回；删除进入可恢复的回收站。不会永久清除文件。</p>
        <div className={styles.tabs} role="group" aria-label="管理记忆状态">
            {(["active", "archived", "deleted"] as const).map(state => <button type="button" key={state} disabled={busy} aria-pressed={mode === state} onClick={() => void load(state)}>{state === "active" ? "当前记忆" : state === "archived" ? "归档" : "回收站"}</button>)}
        </div>
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        {intent && <div className={styles.draft}><p className={styles.muted}>保留同一操作编号，重试不会重复新建。</p><button type="button" className={styles.button} disabled={busy} onClick={() => void submit(intent)}>重试并核对这次操作</button></div>}
        {pending.map(row => <div className={styles.draft} key={row.clientKey}><p className={styles.muted}>待核对：{row.operation === "delete" ? "移入回收站" : row.operation === "archive" ? "归档" : "恢复"} · {row.targetId}</p><button type="button" className={styles.button} disabled={busy} onClick={() => void submit(row)}>恢复核对未决操作</button></div>)}
        <div className={styles.list} style={{ marginTop: 12 }}>
            {loaded && !entries.length && <p className={styles.muted}>此处暂无记忆。</p>}
            {entries.map(entry => <article className={styles.draft} key={entry.id}>
                <p className={styles.cardTitle}>{typeof entry.metadata.name === "string" ? entry.metadata.name : "一段记忆"}</p>
                <p className={styles.preview}>{entry.content}</p>
                <div className={styles.row} style={{ marginTop: 12 }}>
                    {entry.state === "active" ? <><button type="button" className={styles.button} disabled={busy || !!intent} onClick={() => void submit(createIntent(entry, "archive"))}><Archive size={12} aria-hidden="true" />归档这条记忆</button>
                        <button type="button" className={styles.danger} disabled={busy || !!intent} onClick={() => setConfirmation(entry)}><Trash2 size={12} aria-hidden="true" />移到回收站</button></>
                        : <button type="button" className={styles.button} disabled={busy || !!intent} onClick={() => void submit(createIntent(entry, "restore"))}><RotateCcw size={12} aria-hidden="true" />恢复这条记忆</button>}
                </div>
                {confirmation?.id === entry.id && <div className={styles.draft}><p className={styles.muted}>移入回收站后，AI 不再自动读取这条记忆，你仍可恢复。</p><div className={styles.row}><button type="button" className={styles.danger} disabled={busy} onClick={() => void submit(createIntent(entry, "delete"))}>确认移入回收站</button><button type="button" className={styles.quiet} onClick={() => setConfirmation(null)}>取消</button></div></div>}
            </article>)}
        </div>
        {next && <button type="button" className={styles.button} disabled={busy} onClick={() => void load(mode, next)}>继续载入</button>}
        <button type="button" className={styles.quiet} disabled={busy} onClick={() => void load()}>刷新管理列表</button>
        <p className={styles.muted}>归档保留正式文件，通过原生类型和可见性字段禁用召回，不移动原文件。仅本入口建立的归档支持恢复；原生物理归档会拒绝盲目恢复。</p>
    </details>;
}
