"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SharedMemorySummary } from "@/lib/shared-memory-types";
import styles from "./shared-memory.module.css";

/** The isolated MIT renderer receives view data only; all factual operations stay in Float. */
export function SharedMemoryConstellations({ entries, disabled, onSelect, onUseJournal }: {
    entries: SharedMemorySummary[]; disabled: boolean; onSelect: (id: string) => void; onUseJournal: () => void;
}) {
    const frame = useRef<HTMLIFrameElement>(null);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);
    const sendData = useCallback(() => {
        frame.current?.contentWindow?.postMessage({
            type: "float-memory-map-data",
            entries: entries.slice(0, 200).map(entry => ({
                id: entry.id,
                name: (entry.name && entry.name !== entry.id && !/^float_[a-f0-9]+$/i.test(entry.name)
                    ? entry.name : entry.preview.trim().split(/[\n。！？]/)[0] || "一段记忆").slice(0, 300),
                type: entry.type,
                tags: entry.tags.slice(0, 1).map(tag => tag.slice(0, 80)),
                domains: entry.domains.slice(0, 1).map(domain => domain.slice(0, 80)),
            })),
        }, window.location.origin);
    }, [entries]);

    useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin || !event.data || typeof event.data !== "object") return;
            if (event.data.type === "float-memory-map-ready") { setReady(true); setFailed(false); sendData(); }
            else if (event.data.type === "float-memory-map-error") setFailed(true);
            else if (event.data.type === "float-memory-map-select" && !disabled && typeof event.data.id === "string"
                && entries.slice(0, 200).some(entry => entry.id === event.data.id)) onSelect(event.data.id);
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, [disabled, entries, onSelect, sendData]);

    useEffect(() => { if (ready) sendData(); }, [ready, sendData]);
    useEffect(() => {
        if (ready || failed) return;
        const timer = window.setTimeout(() => setFailed(true), 10000);
        return () => window.clearTimeout(timer);
    }, [ready, failed]);
    useEffect(() => {
        const element = frame.current;
        if (!element || !ready) return;
        const observer = new IntersectionObserver(records => {
            element.contentWindow?.postMessage({ type: "float-memory-map-active", active: records.some(record => record.isIntersecting) }, window.location.origin);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [ready]);

    return <div className={styles.mapWrapper}>
        <iframe ref={frame} title="可交互的记忆星海" src="/memory-constellations/frame.html" className={styles.mapFrame}
            referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" onLoad={sendData} onError={() => setFailed(true)} />
        {(!ready || failed) && <div className={styles.mapLoading} role="status">
            <p>{failed ? "星海暂时未能展开，记忆仍可从手札查看。" : "正在点亮你的记忆星海…"}</p>
            {failed && <button type="button" className={styles.button} onClick={onUseJournal}>使用手札查看</button>}
        </div>}
        <p className={styles.skyCaption}>点进星系，读一段被记住的时光</p>
        <p className={styles.mapNote}>按原有类型与首个标签分组 · 当前展示 {Math.min(entries.length, 200)} 条</p>
        <details className={styles.mapAbout}><summary>关于这片星海</summary>
            <p>拖动平移，双指缩放，也可使用缩放按钮和文字导航。中心双星为装饰；组内连线表示布局，不推断感情或语义关系。手札可浏览当前载入的全部结果。</p>
            <a href="https://github.com/ClaraShafiq/MemoryConstellations" target="_blank" rel="noopener noreferrer">基于 MemoryConstellations · Clara Shafiq &amp; Draco Malfoy · MIT</a>
        </details>
    </div>;
}
