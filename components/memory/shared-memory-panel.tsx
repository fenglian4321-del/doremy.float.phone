"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, ChevronRight, Database, LockKeyhole, Moon, Search, Settings2, Sparkles, Stars } from "lucide-react";
import type { SharedMemoryDetail, SharedMemorySummary } from "@/lib/shared-memory-types";
import { SharedMemoryReviewPanel } from "./shared-memory-review-panel";
import { SharedMemoryConstellations } from "./shared-memory-constellations";
import styles from "./shared-memory.module.css";

function memoryDate(value?: string) {
    if (!value || !Number.isFinite(new Date(value).getTime())) return "时间未记录";
    return new Date(value).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function memoryName(entry: SharedMemorySummary) {
    return entry.name && entry.name !== entry.id && !/^float_[a-f0-9]+$/i.test(entry.name)
        ? entry.name : entry.preview.trim().split(/[\n。！？]/)[0] || "一段记忆";
}


type Reply = {
    ok: boolean;
    error?: string;
    configured?: boolean;
    authorized?: boolean;
    entries?: SharedMemorySummary[];
    entry?: SharedMemoryDetail;
    fetchedAt?: string;
};

/** Remote views are kept only in component state, never written to the local memory DB. */
export function SharedMemoryPanel({ source = "local", onSourceChange, initiallyOpen = false, recallMode = "ombre", onRecallModeChange }: {
    source?: "local" | "shared"; onSourceChange?: (source: "local" | "shared") => void; initiallyOpen?: boolean;
    recallMode?: "ombre" | "latent" | "off"; onRecallModeChange?: (mode: "ombre" | "latent" | "off") => void;
}) {
    const [open, setOpen] = useState(false);
    const [configured, setConfigured] = useState<boolean | null>(null);
    const [accessInput, setAccessInput] = useState("");
    const [unlocked, setUnlocked] = useState(false);
    const [query, setQuery] = useState("");
    const [appliedQuery, setAppliedQuery] = useState("");
    const [entries, setEntries] = useState<SharedMemorySummary[]>([]);
    const [detail, setDetail] = useState<SharedMemoryDetail | null>(null);
    const [visibleCount, setVisibleCount] = useState(30);
    const [fetchedAt, setFetchedAt] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [presentation, setPresentation] = useState<"sky" | "journal">("sky");
    const credential = useRef("");
    const pending = useRef<AbortController | null>(null);
    const generation = useRef(0);
    const autoOpened = useRef(false);

    useEffect(() => () => { generation.current++; pending.current?.abort(); credential.current = ""; }, []);

    const clearPrivateView = useCallback(() => {
        credential.current = "";
        setAccessInput(""); setUnlocked(false); setEntries([]); setDetail(null);
        setQuery(""); setAppliedQuery(""); setFetchedAt(""); setVisibleCount(30);
    }, []);

    const read = useCallback(async (params: URLSearchParams, token: string, body?: Record<string, unknown>): Promise<Reply | null> => {
        pending.current?.abort();
        const controller = new AbortController();
        pending.current = controller;
        const version = ++generation.current;
        setBusy(true); setError("");
        try {
            const response = await fetch(body ? "/api/shared-memory" : `/api/shared-memory?${params}`, {
                method: body ? "POST" : "GET",
                headers: { ...(token ? { "x-float-memory-access-token": token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                cache: "no-store", credentials: "same-origin", signal: controller.signal,
            });
            const reply = await response.json() as Reply;
            if (version !== generation.current) return null;
            if (!response.ok || !reply.ok) {
                if (response.status === 401) clearPrivateView();
                throw new Error(reply.error || "无法读取共享记忆。");
            }
            return reply;
        } catch (cause) {
            if (!controller.signal.aborted && version === generation.current) {
                setError(cause instanceof Error ? cause.message : "无法读取共享记忆。");
            }
            return null;
        } finally { if (version === generation.current) setBusy(false); }
    }, [clearPrivateView]);

    const close = useCallback(() => {
        generation.current++; pending.current?.abort();
        clearPrivateView(); setOpen(false); setConfigured(null); setError(""); setBusy(false);
    }, [clearPrivateView]);

    const loadEntries = useCallback(async (token = credential.current, search = query.trim()) => {
        if (token && !unlocked) {
            const connected = await read(new URLSearchParams(), token, { action: "connect" });
            if (!connected) return;
        }
        const reply = await read(new URLSearchParams(search ? { action: "search", q: search } : { action: "list" }), token);
        if (!reply) return;
        credential.current = token;
        setAccessInput(""); setUnlocked(true); setEntries((reply.entries ?? []).filter(entry => entry.type !== "archived"));
        setDetail(null); setAppliedQuery(search); setVisibleCount(30); setFetchedAt(reply.fetchedAt ?? "");
    }, [read, query, unlocked]);

    const show = useCallback(async () => {
        setOpen(true);
        const reply = await read(new URLSearchParams({ action: "status" }), "");
        if (reply) {
            setConfigured(reply.configured === true);
            if (reply.authorized) await loadEntries("", "");
        }
    }, [read, loadEntries]);

    useEffect(() => {
        if (initiallyOpen && !autoOpened.current) { autoOpened.current = true; void show(); }
    }, [initiallyOpen, show]);

    const loadDetail = useCallback(async (id: string) => {
        const reply = await read(new URLSearchParams({ action: "detail", id }), credential.current);
        if (reply) { setDetail(reply.entry ?? null); setFetchedAt(reply.fetchedAt ?? ""); }
    }, [read]);

    return (
        <section aria-label="心潮共享记忆" className={styles.root}>
            <header className={styles.hero}>
                <div className={styles.heroTop}>
                    <span className={styles.eyebrow}><Moon size={12} aria-hidden="true" /> FLOAT · MEMORY SPACE</span>
                    <button type="button" className={styles.quiet} onClick={() => { if (open) close(); else void show(); }} aria-expanded={open}>
                        {open ? "收起" : "打开"}<ArrowUpRight size={13} aria-hidden="true" />
                    </button>
                </div>
                <h2 className={styles.title}>拾光 · 记忆之间</h2>
                <p className={styles.subtitle}>让那些细小的瞬间，<br />在这里，慢慢连成星光。</p>
                <div className={styles.heroBottom}><span className={styles.heroRule} /><span>每一段记忆，都可以被重新读懂</span><Sparkles size={13} aria-hidden="true" /></div>
            </header>
            {open && <div className={styles.body}>
                {error && <p role="alert" className={styles.alert}>{error}</p>}
                {busy && <p role="status" className={styles.loading}>正在拾取记忆…</p>}
                {configured === false && <div className={styles.empty}><LockKeyhole size={25} aria-hidden="true" /><p>记忆空间还在等待连接</p><span>服务配置完成后，记忆会在这里呈现。</span></div>}
                {configured === null && !busy && <button type="button" className={styles.button} onClick={() => void show()}>重新检查</button>}
                {configured && !unlocked && <div className={styles.connection}>
                    <span className={styles.eyebrow}>A PRIVATE PLACE</span><h3 className={styles.sectionTitle}>打开你的记忆空间</h3>
                    <p className={styles.muted}>连接后，AI 可以自动记忆，你也能随时回来查看与纠错。</p>
                    <form onSubmit={event => { event.preventDefault(); void loadEntries(accessInput, ""); }}>
                        <label htmlFor="shared-memory-access">共享记忆访问口令</label>
                        <input id="shared-memory-access" type="password" className={styles.input} autoComplete="off" spellCheck={false}
                            maxLength={512} value={accessInput} onChange={event => setAccessInput(event.target.value)} aria-describedby="shared-memory-access-help" />
                        <button type="submit" className={styles.primary} disabled={busy || !accessInput}><LockKeyhole size={14} aria-hidden="true" />读取共享库</button>
                        <p id="shared-memory-access-help" className={styles.muted}>使用 Float 独立访问口令，连接会话有效期为 7 天，可随时断开。</p>
                    </form>
                </div>}
                {unlocked && <>
                    <div className={styles.toolbar}>
                        <div><span className={styles.eyebrow}>COLLECTED MOMENTS</span><h3 className={styles.sectionTitle}>记忆的形状 <span className={styles.count}>{entries.length}</span></h3></div>
                        <span className={styles.badge} data-tone={source === "shared" ? undefined : "warm"}><span className={styles.dot} />{source === "shared" ? "共享已启用" : "仅浏览"}</span>
                    </div>
                    <form onSubmit={event => { event.preventDefault(); void loadEntries(); }} className={styles.search}>
                        <Search size={15} aria-hidden="true" /><input className={styles.input} aria-label="搜索共享记忆" placeholder="寻找某个被记住的瞬间…" maxLength={500} value={query} onChange={event => setQuery(event.target.value)} />
                        <button type="submit" className={styles.quiet} disabled={busy}>{query.trim() ? "搜索" : "刷新"}</button>
                    </form>
                    <p className={styles.muted}>最后读取：{fetchedAt && Number.isFinite(new Date(fetchedAt).getTime()) ? new Date(fetchedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "时间未知"} · 刷新可获取其他设备的最新修改</p>
                    <div className={styles.viewBar}>
                        <div className={styles.tabs} role="group" aria-label="记忆呈现方式">
                            <button type="button" aria-pressed={presentation === "sky"} onClick={() => { setPresentation("sky"); setDetail(null); }}><Stars size={13} aria-hidden="true" />星海</button>
                            <button type="button" aria-pressed={presentation === "journal"} onClick={() => { setPresentation("journal"); setDetail(null); }}><BookOpen size={13} aria-hidden="true" />手札</button>
                        </div>
                        <span className={styles.date}>{appliedQuery ? "搜索结果" : "当前载入的记忆"}</span>
                    </div>
                    {detail ? <article className={styles.detail}>
                        <div className={styles.detailHeading}><button type="button" className={styles.paperButton} onClick={() => setDetail(null)}><ArrowLeft size={13} aria-hidden="true" />返回列表</button><span>MEMORY FRAGMENT</span></div>
                        <span className={styles.letterMark}>“</span><p className={styles.content}>{detail.content}</p>
                        <p className={styles.letterFooter}>被记住的，此刻仍可以被温柔修正。<Sparkles size={12} aria-hidden="true" /></p>
                        <details className={styles.paperFold}><summary>来源与原始元数据</summary><p className={styles.muted}>Ombre ID：{detail.id}</p><pre className={styles.code}>{JSON.stringify(detail.metadata, null, 2)}</pre></details>
                    </article> : !entries.length ? <div className={styles.empty}><Stars size={30} aria-hidden="true" /><p>{appliedQuery ? "这一片星海里，还没有找到它" : "星海，等待第一段记忆"}</p><span>{appliedQuery ? "换一个关键词，再找找看。" : "AI 保存的记忆会在这里出现，也可以亲手写下一条。"}</span></div> : presentation === "sky" ? <SharedMemoryConstellations entries={entries} disabled={busy} onSelect={id => void loadDetail(id)} onUseJournal={() => setPresentation("journal")} /> : <div className={styles.list}>
                        {entries.slice(0, visibleCount).map((entry, index) => <button type="button" key={entry.id} className={styles.memoryCard} disabled={busy} onClick={() => void loadDetail(entry.id)}>
                            <div className={styles.cardTop}><span className={styles.badge} data-tone={entry.type === "permanent" ? "warm" : undefined}>{entry.type === "permanent" ? "恒常记忆" : "日常片段"}</span><span className={styles.date}>{memoryDate(entry.createdAt)}</span></div>
                            <span className={styles.cardTitle}>{memoryName(entry)}</span>{entry.preview.trim() !== memoryName(entry) && <p className={styles.preview}>{entry.preview}</p>}
                            <div className={styles.cardFooter}><div className={styles.tags}>{entry.tags.slice(0, 3).map(tag => <span className={styles.tag} key={tag}># {tag}</span>)}{entry.dontSurface && <span className={styles.tag}>不自动召回</span>}</div><span className={styles.cardNumber}>{String(index + 1).padStart(2, "0")}<ChevronRight size={12} aria-hidden="true" /></span></div>
                        </button>)}
                        {entries.length > visibleCount && <button type="button" className={styles.button} onClick={() => setVisibleCount(count => count + 30)}>再显示 30 条</button>}
                    </div>}
                    <SharedMemoryReviewPanel accessToken={credential.current} selectedId={detail?.id} onUnauthorized={close}
                        onCommitted={id => { void loadDetail(id); }} onManaged={() => { void loadEntries(); }} source={source} onSourceChange={onSourceChange} recallMode={recallMode} onRecallModeChange={onRecallModeChange} />
                    <details className={styles.fold}><summary><Database size={13} aria-hidden="true" />记忆来源与连接</summary>
                        <p className={styles.muted}>来源：心潮 Ombre 正式库 · 本次读取 {fetchedAt && Number.isFinite(new Date(fetchedAt).getTime()) ? new Date(fetchedAt).toLocaleString("zh-CN") : "时间未知"}</p>
                        <p className={styles.muted}>{appliedQuery ? "原生搜索最多返回 10 条可展示结果，并非全库全文搜索。" : "人工浏览也可能包含归档或不自动浮现的条目，不等于模型会召回这些记忆。"}本页不会另存一份本机记忆。</p>
                        <button type="button" className={styles.danger} disabled={busy} onClick={() => { void read(new URLSearchParams(), credential.current, { action: "disconnect" }).then(() => close()); }}>断开共享记忆</button>
                    </details>
                    <p className={styles.footer}>SOME MOMENTS DESERVE TO STAY</p>
                </>}
                {source === "shared" && onSourceChange && <details className={styles.fold}><summary><Settings2 size={13} aria-hidden="true" />本设备的记忆来源</summary>
                    <p className={styles.muted}>当前使用共享库。可以明确切回本机来源，不会复制或删除共享内容。连接失败时不会自动回退本机。</p>
                    <button type="button" className={styles.button} onClick={() => { close(); onSourceChange("local"); }}>改用本机记忆</button>
                </details>}
            </div>}
        </section>
    );
}
