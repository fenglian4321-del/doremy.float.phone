"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Download, Wallet } from "lucide-react";
import { clearUsageLedger, getUsageLedger, summarizeUsage, USAGE_RETENTION_DAYS, USAGE_REASON_LABELS, type UsageLedgerEntry } from "@/lib/usage-ledger";
import { loadApiConfigs } from "@/lib/settings-storage";
import { queryProviderBalance, supportsBalance, type ProviderBalance } from "@/lib/provider-balance";
import type { ApiConfig } from "@/lib/settings-types";
import styles from "./shared-memory.module.css";

const sourceNames = { chat: "聊天与工具", background: "后台整理", embedding: "向量生成", qa: "工坊答疑", tool: "Codex 只读工具（不计模型 Token）", work: "独立工作区", private: "AI私人空间" };
export function UsageLedgerPanel() {
    const [rows, setRows] = useState<UsageLedgerEntry[]>([]);
    const [period, setPeriod] = useState<"day" | "month" | "all">("month");
    const [source, setSource] = useState("all");
    const [model, setModel] = useState("all");
    const [scope, setScope] = useState("");
    const [clear, setClear] = useState(false);
    const [configs, setConfigs] = useState<ApiConfig[]>([]);
    const [configId, setConfigId] = useState("");
    const [balance, setBalance] = useState<ProviderBalance | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef<AbortController | null>(null);
    useEffect(() => {
        const refresh = () => { setRows(getUsageLedger()); setConfigs(loadApiConfigs()); };
        refresh(); window.addEventListener("float-usage-ledger-updated", refresh); window.addEventListener("focus", refresh);
        return () => { window.removeEventListener("float-usage-ledger-updated", refresh); window.removeEventListener("focus", refresh); pending.current?.abort(); };
    }, []);
    const filtered = useMemo(() => {
        const now = new Date();
        const since = period === "day" ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() : period === "month" ? new Date(now.getFullYear(), now.getMonth(), 1).getTime() : 0;
        return rows.filter(row => Date.parse(row.at) >= since && (source === "all" || row.source === source) && (model === "all" || `${row.provider} · ${row.model}` === model) && (!scope.trim() || row.scopeId === scope.trim()));
    }, [rows, period, source, model, scope]);
    const summary = summarizeUsage(filtered);
    const amount = (key: keyof typeof summary.totals) => summary.reported[key] ? summary.totals[key].toLocaleString("zh-CN") : "未取得";
    const selected = configs.find(config => config.id === configId);
    const queryBalance = async () => {
        if (!selected) return;
        pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
        setBusy(true); setError(""); setBalance(null);
        try { const result = await queryProviderBalance(selected, fetch, controller.signal); if (!controller.signal.aborted) setBalance(result); }
        catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "未取得余额。"); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const exportRows = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: "float-usage/v1", exportedAt: new Date().toISOString(), entries: filtered }, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "float-usage.json"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return <section className={styles.root} aria-label="用量与缓存" style={{ marginTop: 16 }}><div className={styles.body}>
        <span className={styles.eyebrow}>USAGE & CACHE</span><h3 className={styles.sectionTitle}><Activity size={14} aria-hidden="true" /> 用量与缓存</h3>
        <p className={styles.muted}>本设备此页面收集的模型 HTTP 调用，包含聊天、工具循环、后台整理和本机向量生成。不会保存提示词、记忆正文或密钥；不等同完整供应商账单或 VPS 总用量。</p>
        <div className={styles.tabs} role="group" aria-label="用量时间范围">{(["day", "month", "all"] as const).map(value => <button type="button" key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{value === "day" ? "今天" : value === "month" ? "本月" : "保留期"}</button>)}</div>
        <div className={styles.usageFilters}>
            <label>来源<select className={styles.usageSelect} aria-label="用量来源" value={source} onChange={event => setSource(event.target.value)}><option value="all">全部来源</option>{Object.entries(sourceNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>模型<select className={styles.usageSelect} aria-label="用量模型" value={model} onChange={event => setModel(event.target.value)}><option value="all">全部模型</option>{Array.from(new Set(rows.map(row => `${row.provider} · ${row.model}`))).map(name => <option key={name}>{name}</option>)}</select></label>
        </div>
        <div className={styles.usageGrid}>
            <div><small>请求次数</small><strong>{summary.requests}</strong><span>失败/取消 {summary.errors} · 进行中 {summary.pending}</span></div>
            <div><small>输入 Token</small><strong>{amount("prompt_tokens")}</strong><span>已采集 {summary.reported.prompt_tokens}/{summary.modelRequests} 次模型调用</span></div>
            <div><small>输出 Token（接口口径）</small><strong>{amount("completion_tokens")}</strong><span>已采集 {summary.reported.completion_tokens}/{summary.modelRequests} 次模型调用</span></div>
            <div><small>接口报告总 Token</small><strong>{amount("total_tokens")}</strong><span>已采集 {summary.reported.total_tokens}/{summary.modelRequests} 次模型调用</span></div>
        </div>
        <div className={styles.status}><div><span className={styles.statusTitle}>缓存命中率 {summary.cacheHitRate === undefined ? "未知" : `${(summary.cacheHitRate * 100).toFixed(1)}%`}</span><p className={styles.muted}>只计算同时取得输入与缓存数据的 {summary.cacheCoverage} 次调用。</p></div></div>
        <p className={styles.muted}>缓存读取 {amount("cached_tokens")} · 缓存创建 {amount("cache_creation_tokens")} · 推理细项 {amount("reasoning_tokens")}。这些细项不再加进接口总量。{summary.unknown} 次模型调用未取得任何用量，不能当作零消耗。{summary.toolRequests} 次 Codex 工具执行单列，不计模型 Token。没有可靠单价时费用保持未知。</p>
        <details className={styles.fold}><summary>逐次调用与会话筛选</summary>
            <label className={styles.muted}>会话/轮次标识（可选，精确匹配）<input className={styles.input} aria-label="用量会话标识" value={scope} onChange={event => setScope(event.target.value)} placeholder="调用方提供的非正文标识" /></label>
            <p className={styles.muted}>只收集调用方提供的标识，缺失时无法按会话汇总；一次回复中的工具循环与重试按多次 HTTP 请求记账。</p>
            {!filtered.length && <p className={styles.muted}>此范围暂无已收集的调用，不代表历史上没有消耗。</p>}
            {filtered.slice(-50).reverse().map(row => <article className={styles.draft} key={row.id}><p className={styles.cardTitle}>{row.provider} · {row.model}</p><p className={styles.muted}>{new Date(row.at).toLocaleString("zh-CN")} · {sourceNames[row.source]} · {row.status === "pending" ? "进行中/结果未决" : row.status === "completed" ? "请求完成" : row.status === "cancelled" ? "已取消" : "请求失败"}</p><p className={styles.muted}>调用原因：{USAGE_REASON_LABELS[row.reason || "unknown"]}</p><p className={styles.muted}>输入 {row.usage?.prompt_tokens ?? "未知"} / 输出 {row.usage?.completion_tokens ?? "未知"} / 缓存 {row.usage?.cached_tokens ?? "未知"}{row.scopeId ? ` · 标识 ${row.scopeId}` : ""}</p></article>)}
            <div className={styles.row}><button type="button" className={styles.button} onClick={exportRows}><Download size={12} aria-hidden="true" />导出当前统计</button><button type="button" className={styles.quiet} onClick={() => setClear(true)}>清空本机统计</button></div>
            {clear && <div className={styles.row}><span className={styles.muted}>只清统计，不清聊天或记忆。</span><button type="button" className={styles.danger} onClick={() => { clearUsageLedger(); setClear(false); }}>确认清空统计</button><button type="button" className={styles.quiet} onClick={() => setClear(false)}>取消</button></div>}
        </details>
        <details className={styles.fold}><summary><Wallet size={13} aria-hidden="true" />供应商余额</summary>
            <select className={styles.usageSelect} aria-label="余额查询配置" value={configId} onChange={event => { pending.current?.abort(); setBusy(false); setBalance(null); setError(""); setConfigId(event.target.value); }}><option value="">选择已有 API 配置</option>{configs.map(config => <option key={config.id} value={config.id}>{config.name || config.provider}</option>)}</select>
            <p className={styles.muted}>{selected && supportsBalance(selected) ? "按需查询 DeepSeek 官方余额，查询不会调用模型。" : "仅已核实的 DeepSeek 官方接口支持查询；中转、硅基流动及其他配置目前显示未知，不会把中转密钥发送给原厂。"}</p>
            <button type="button" className={styles.button} disabled={busy || !selected || !supportsBalance(selected)} onClick={() => void queryBalance()}>{busy ? "查询中…" : "查询余额"}</button>
            {error && <p role="alert" className={styles.alert}>{error}</p>}
            {balance && <div className={styles.draft}>{balance.balances.map(item => <p className={styles.cardTitle} key={item.currency}>{item.total} {item.currency}</p>)}<p className={styles.muted}>{balance.available ? "接口报告余额可用" : "接口报告余额不足"} · {new Date(balance.at).toLocaleString("zh-CN")}</p></div>}
        </details>
        <p className={styles.footer}>仅保留最近 {USAGE_RETENTION_DAYS} 天、最多 20,000 条；旧调试日志不会自动导入。VPS 内部模型、图像、语音及其他未接入出口的调用尚未计入。</p>
    </div></section>;
}
