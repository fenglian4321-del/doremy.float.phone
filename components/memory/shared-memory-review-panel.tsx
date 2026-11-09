"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, History, Pencil, Plus, RefreshCw, Settings2, Sparkles, Undo2 } from "lucide-react";
import styles from "./shared-memory.module.css";
import { SharedMemoryManagementPanel, type ManagementReply } from "./shared-memory-management-panel";
import { OrbisMemoryImportPanel, type OrbisImportReply } from "./orbis-memory-import-panel";
import type { SharedMemoryCandidate, SharedMemoryHistory, SharedMemoryPolicy, SharedMemoryReviewDetail } from "@/lib/shared-memory-types";

type Reply = ManagementReply & OrbisImportReply & {
    ok: boolean; error?: string;
    review?: { available: boolean; policy?: SharedMemoryPolicy; nativeWritesReviewed?: boolean; management?: boolean; latent?: boolean; latentMode?: "lexical-graph-v1" | "semantic-hybrid-v1"; latentIndexState?: string; orbisImport?: boolean };
    candidates?: SharedMemoryCandidate[]; total?: number;
    candidate?: SharedMemoryCandidate; entry?: SharedMemoryReviewDetail;
    history?: SharedMemoryHistory[]; policy?: SharedMemoryPolicy;
};
type Draft = {
    kind: "create" | "edit" | "revise"; content: string; clientKey: string;
    targetId?: string; baseRevision?: string; before?: string;
    candidateId?: string; version?: number;
};

export function SharedMemoryReviewPanel({ accessToken, selectedId, onUnauthorized, onCommitted, onManaged, source, onSourceChange, recallMode = "ombre", onRecallModeChange }: {
    accessToken: string; selectedId?: string; onUnauthorized: () => void; onCommitted: (id: string) => void;
    onManaged?: () => void;
    recallMode?: "ombre" | "latent" | "off"; onRecallModeChange?: (mode: "ombre" | "latent" | "off") => void;
    source?: "local" | "shared"; onSourceChange?: (source: "local" | "shared") => void;
}) {
    const [ready, setReady] = useState(false);
    const [policy, setPolicy] = useState<SharedMemoryPolicy | null>(null);
    const [nativeReviewed, setNativeReviewed] = useState(false);
    const [management, setManagement] = useState(false);
    const [latentReady, setLatentReady] = useState(false);
    const [latentSemantic, setLatentSemantic] = useState(false);
    const [latentState, setLatentState] = useState("");
    const [orbisReady, setOrbisReady] = useState(false);
    const [candidates, setCandidates] = useState<SharedMemoryCandidate[]>([]);
    const [total, setTotal] = useState(0);
    const [history, setHistory] = useState<SharedMemoryHistory[] | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef<AbortController | null>(null);
    const generation = useRef(0);
    const undoKeys = useRef(new Map<string, string>());
    const cancel = useCallback(() => { generation.current++; pending.current?.abort(); }, []);

    const request = useCallback(async (action: string, payload?: Record<string, unknown>, id?: string, extra?: Record<string, string>): Promise<Reply | null> => {
        pending.current?.abort();
        const controller = new AbortController();
        pending.current = controller;
        const current = ++generation.current;
        setBusy(true); setError("");
        try {
            const params = new URLSearchParams({ action });
            if (id) params.set("id", id);
            for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
            const response = await fetch(payload ? "/api/shared-memory" : `/api/shared-memory?${params}`, {
                method: payload ? "POST" : "GET",
                headers: { "x-float-memory-access-token": accessToken, ...(payload ? { "Content-Type": "application/json" } : {}) },
                body: payload ? JSON.stringify({ action, ...payload }) : undefined,
                cache: "no-store", credentials: "same-origin", signal: controller.signal,
            });
            const reply = await response.json() as Reply;
            if (current !== generation.current) return null;
            if (!response.ok || !reply.ok) {
                if (response.status === 401) { onUnauthorized(); return null; }
                throw new Error(reply.error || "共享审核操作失败，请刷新核对。");
            }
            return reply;
        } catch (cause) {
            if (!controller.signal.aborted && current === generation.current) setError(cause instanceof Error ? cause.message : "共享审核操作失败。");
            return null;
        } finally { if (current === generation.current) setBusy(false); }
    }, [accessToken, onUnauthorized]);

    const refresh = useCallback(async () => {
        const reply = await request("review_candidates");
        if (reply) { setCandidates(reply.candidates ?? []); setTotal(reply.total ?? 0); }
    }, [request]);
    const refreshStatus = async () => {
        const reply = await request("review_status");
        if (!reply?.review?.available) return;
        setPolicy(reply.review.policy ?? null);
        await refresh();
    };

    useEffect(() => {
        void (async () => {
            const reply = await request("review_status");
            if (!reply) return;
            setReady(reply.review?.available === true);
            setPolicy(reply.review?.policy ?? null);
            setNativeReviewed(reply.review?.nativeWritesReviewed === true);
            setManagement(reply.review?.management === true);
            setLatentReady(reply.review?.latent === true);
            setLatentSemantic(reply.review?.latentMode === "semantic-hybrid-v1");
            setLatentState(reply.review?.latentIndexState ?? "");
            setOrbisReady(reply.review?.orbisImport === true);
            if (reply.review?.available) await refresh();
        })();
        return cancel;
    }, [request, refresh, cancel]);

    useEffect(() => { setHistory(null); }, [selectedId]);

    const mutate = async (action: string, payload: Record<string, unknown>) => {
        setNotice("");
        const reply = await request(action, payload);
        if (!reply) return false;
        if (reply.policy) { setPolicy(reply.policy); setNotice(reply.policy.paused ? "AI 自动记忆已暂停，你仍可手工纠错。" : reply.policy.reviewRequired ? "AI 记忆改为先确认再保存。" : "AI 记忆会自动保存，无需逐条确认。"); return true; }
        if (reply.candidate) {
            const row = reply.candidate;
            if (row.state === "approved") {
                setNotice("已保存到 Ombre 记忆库，正在重新读取正文。");
                setHistory(null); onCommitted(row.targetId);
            } else if (row.state === "rejected") setNotice("已忽略，没有写入正式库。");
            else setNotice("已提交到待确认区，尚未写入正式库。");
        }
        await refresh();
        return true;
    };

    const beginEdit = async () => {
        if (!selectedId) return;
        const reply = await request("review_detail", undefined, selectedId);
        if (reply?.entry) setDraft({ kind: "edit", content: reply.entry.content, before: reply.entry.content,
            clientKey: crypto.randomUUID(), targetId: reply.entry.id, baseRevision: reply.entry.revision });
    };

    const submitDraft = async () => {
        if (!draft) return;
        const ok = draft.kind === "revise"
            ? await mutate("review_revise", { id: draft.candidateId, version: draft.version, content: draft.content })
            : await mutate("review_save", { clientKey: draft.clientKey, kind: draft.kind, content: draft.content,
                ...(draft.kind === "edit" ? { targetId: draft.targetId, baseRevision: draft.baseRevision } : {}), source: { origin: "float_user" } });
        if (ok) setDraft(null);
    };

    return (
        <section aria-label="共享记忆编辑" className={styles.review}>
            {error && <p role="alert" className={styles.alert}>{error}</p>}
            {notice && <p role="status" className={styles.notice}>{notice}</p>}
            {!ready ? <p className={styles.muted}>{busy ? "正在连接记忆编辑服务…" : "记忆编辑服务尚未就绪，暂时只读。"}</p> : <>
                {onSourceChange && source !== "shared" && <div className={styles.draft}>
                    <h3 className={styles.sectionTitle}>让聊天也使用这份记忆</h3>
                    <p className={styles.muted}>现在仅在浏览共享库，聊天仍使用本机记忆。启用后，本设备所有角色的 AI 写入与召回都会使用这份 VPS 共享库；原有本机记忆保留，不自动上传旧聊天。</p>
                    <button type="button" className={styles.primary} disabled={busy} onClick={() => onSourceChange("shared")}>启用 VPS 共享记忆</button>
                </div>}
                <div className={styles.status}>
                    <div><span className={styles.statusTitle}><Sparkles size={13} aria-hidden="true" />{policy?.paused ? "共享库已暂停 AI 写入" : policy?.reviewRequired ? "共享库新记忆需要确认" : source === "shared" ? "AI 自动记忆中" : "共享库允许 AI 自动写入"}</span><p className={styles.muted}>{source === "shared" ? "聊天与此处使用同一份共享记忆。" : "启用共享来源后，聊天才会使用这里的记忆。"}</p></div>
                    <span className={styles.statusSymbol} aria-hidden="true">✧</span>
                </div>
                <div className={styles.actions}>
                    {selectedId && <button type="button" className={styles.primary} disabled={busy} onClick={() => void beginEdit()}><Pencil size={13} aria-hidden="true" />修改当前正文</button>}
                    <button type="button" className={selectedId ? styles.button : styles.primary} disabled={busy} onClick={() => setDraft({ kind: "create", content: "", clientKey: crypto.randomUUID() })}><Plus size={14} aria-hidden="true" />手工新增记忆</button>
                    {selectedId && <button type="button" className={styles.button} disabled={busy} onClick={() => { void request("review_history", undefined, selectedId).then(reply => { if (reply) setHistory(reply.history ?? []); }); }}><History size={14} aria-hidden="true" />查看正文历史</button>}
                </div>
                {draft && <form onSubmit={event => { event.preventDefault(); void submitDraft(); }} className={styles.draft}>
                    <span className={styles.eyebrow}>A NOTE TO REMEMBER</span><h3 className={styles.sectionTitle}>{draft.kind === "create" ? "写下一段记忆" : draft.kind === "edit" ? "让这段记忆，更准确一点" : "修正待确认内容"}</h3>
                    {draft.before !== undefined && <details className={styles.fold}><summary>查看原正文</summary><pre className={styles.code}>{draft.before}</pre></details>}
                    <textarea className={styles.textarea} aria-label="记忆正文" placeholder="写下你希望被记住的内容…" maxLength={12000} rows={6} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} />
                    <div className={styles.row}><button type="submit" className={styles.primary} disabled={busy || !draft.content.trim()}><Check size={14} aria-hidden="true" />{draft.kind === "revise" ? "保存提案修正" : "保存记忆"}</button>
                        <button type="button" className={styles.quiet} disabled={busy} onClick={() => setDraft(null)}>取消编辑</button></div>
                    <p className={styles.muted}>手工保存直接生效，后续读取会使用改后的正文。</p>
                </form>}
                {(total > 0 || policy?.reviewRequired) && <div className={styles.queueHeading}><h3 className={styles.sectionTitle}>等待你读过的记忆 <span className={styles.count}>{total}</span></h3><p className={styles.muted}>显示前 100 条。版本冲突时需重新读取，结果未决时先恢复核对。</p></div>}
                {candidates.map(row => <article key={row.id} className={styles.draft}>
                    <h3 className={styles.sectionTitle}>{row.kind === "create" ? "新增记忆" : "正文修改"} · {row.state === "pending" ? "待确认" : row.state === "applying" ? "结果未决" : "版本冲突"}</h3>
                    <p className={styles.muted}>提案版本 {row.version}</p>
                    <details className={styles.fold}><summary>来源信息</summary><p className={styles.muted}>{row.targetId}</p><pre className={styles.code}>{JSON.stringify(row.source, null, 2)}</pre></details>
                    {row.before && <details className={styles.fold}><summary>修改前</summary><pre className={styles.before}>{row.before.content}</pre></details>}
                    <p className={styles.muted}>拟保存正文</p><pre className={styles.after}>{row.content}</pre>
                    <div className={styles.row}>
                        {row.state !== "conflict" && <button type="button" className={styles.primary} disabled={busy} onClick={() => void mutate("review_approve", { id: row.id, version: row.version })}>{row.state === "applying" ? "恢复核对这次写入" : "确认入库"}</button>}
                        {row.state === "pending" && <button type="button" className={styles.button} disabled={busy} onClick={() => setDraft({ kind: "revise", content: row.content, before: row.content, clientKey: crypto.randomUUID(), candidateId: row.id, version: row.version })}>修正后再确认</button>}
                        {row.state !== "applying" && <button type="button" className={styles.quiet} disabled={busy} onClick={() => void mutate("review_reject", { id: row.id, version: row.version })}>忽略此提案</button>}
                    </div>
                </article>)}
                {history && <div className={styles.history}>
                    <span className={styles.eyebrow}>TRACES OF TIME</span><h3 className={styles.sectionTitle}>这段记忆，曾经的样子</h3><p className={styles.muted}>本入口记录的最近 30 次正文写入</p>
                    {!history.length && <p className={styles.muted}>暂无经本扩展记录的历史，其他方式的修改可能不在此列。</p>}
                    <div className={styles.timeline}>{history.map(item => <details key={item.id} className={styles.historyItem}>
                        <summary>{new Date(item.at).toLocaleString("zh-CN")} · {item.before ? "正文修改" : "新增"}</summary>
                        <p className={styles.muted}>修改前</p><pre className={styles.before}>{item.before?.content ?? "（新增记忆，无旧正文）"}</pre>
                        <p className={styles.muted}>修改后</p><pre className={styles.after}>{item.after.content}</pre>
                        <details className={styles.fold}><summary>本次写入来源</summary><pre className={styles.code}>{JSON.stringify(item.source, null, 2)}</pre></details>
                        {item.before && <button type="button" className={styles.button} disabled={busy} onClick={() => {
                            const key = undoKeys.current.get(item.id) ?? crypto.randomUUID(); undoKeys.current.set(item.id, key);
                            void mutate("review_undo_save", { id: item.id, clientKey: key });
                        }}><Undo2 size={13} aria-hidden="true" />撤销这次正文修改</button>}
                    </details>)}</div><p className={styles.muted}>撤销会核对版本，避免覆盖后来的修改。</p>
                </div>}
                {management && <SharedMemoryManagementPanel request={request} busy={busy} onChanged={() => onManaged?.()} />}
                {orbisReady && <OrbisMemoryImportPanel request={request} busy={busy} onChanged={() => onManaged?.()} />}
                <details className={styles.fold} data-memory-settings><summary><Settings2 size={13} aria-hidden="true" />记忆偏好</summary>
                    {onRecallModeChange && <label className={styles.setting}><span>本设备的自动召回<small>关闭后仍可浏览和手工检索</small></span><select className={styles.usageSelect} style={{ width: "auto", maxWidth: "60%" }} aria-label="共享记忆自动召回方式" value={recallMode} onChange={event => onRecallModeChange(event.target.value as "ombre" | "latent" | "off")}>
                        <option value="ombre">Ombre 原生召回</option><option value="latent" disabled={!latentReady}>Latent · {latentSemantic ? "语义/词面/图谱" : "本地词面/图谱"}{latentReady ? "" : "（未启用）"}</option><option value="off">关闭自动召回</option>
                    </select></label>}
                    {onSourceChange && <><label className={styles.setting}>
                        <input type="checkbox" aria-label="让 Float 使用这份共享记忆" checked={source === "shared"} disabled={busy} onChange={event => onSourceChange(event.target.checked ? "shared" : "local")} />
                        <span>让 Float 使用这份共享记忆<small>本设备的写入与召回使用同一份共享库</small></span></label>
                        <p className={styles.muted}>开启后本机旧库保留，不自动上传旧聊天。同一私人库由本设备所有角色共用。断开或连接失败不会自动改写本机。</p></>}
                    {policy && <label className={styles.setting}><input type="checkbox" aria-label="暂停 AI 自动记忆" checked={policy.paused} disabled={busy} onChange={event => void mutate("review_policy", { paused: event.target.checked, version: policy.version })} />
                        <span>暂停 AI 自动记忆<small>暂停后仍可手工纠错</small></span></label>}
                    {policy && <label className={styles.setting}><input type="checkbox" aria-label="AI 写入前需要我确认（可选）" checked={policy.reviewRequired} disabled={busy} onChange={event => void mutate("review_policy", { paused: policy.paused, reviewRequired: event.target.checked, version: policy.version })} />
                        <span>AI 写入前需要我确认（可选）<small>默认关闭，AI 可以自己记下新内容</small></span></label>}
                    <p className={styles.muted}>暂停和确认设置由这份共享库的连接设备共用。{!nativeReviewed && "仅影响经本服务的写入，其他客户端仍按各自规则处理。"}{latentReady ? latentSemantic ? "Latent 语义模式会把查询与符合召回条件的正文发给服务端已配置的 embedding 供应商；索引只在内存派生，不另存事实。首次或正文变化后会后台重建，未就绪时明确报错。" : "Latent 仅在内存中派生词面/图谱索引，不另存事实，不调用 embedding 模型。" : "服务端尚未启用 Latent。"}{latentSemantic && latentState && ` 连接时索引状态：${({ unstarted: "尚未构建", building: "构建中", ready: "就绪", outdated: "待更新", error: "构建未成功" } as Record<string, string>)[latentState] ?? "未知"}。`}</p>
                    <button type="button" className={styles.button} disabled={busy} onClick={() => void refreshStatus()}><RefreshCw size={13} aria-hidden="true" />刷新状态</button>
                </details>
            </>}
        </section>
    );
}
