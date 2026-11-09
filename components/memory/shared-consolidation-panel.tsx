"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadChatSessions, resolveSessionCharacterId, type ChatSession } from '@/lib/chat-storage';
import { loadCharacters } from '@/lib/character-storage';
import { loadMemoryConfig, saveMemoryConfig } from '@/lib/memory-storage';
import { consolidationCall, observeConsolidation, resumeConsolidation, readConsolidationDiagnostics, type ConsolidationDiagnostics, type ConsolidationStatus } from '@/lib/consolidation-client';
import type { ConsolidationConfig, ConsolidationScope } from '@/lib/consolidation-protocol';
import styles from './shared-memory.module.css';

export function SharedConsolidationPanel() {
    const [sessions, setSessions] = useState<ChatSession[]>([]), [sessionId, setSessionId] = useState('');
    const [status, setStatus] = useState<ConsolidationStatus | null>(null), [draft, setDraft] = useState<ConsolidationConfig | null>(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [paused, setPaused] = useState(false);
    const [diagnostics, setDiagnostics] = useState<ConsolidationDiagnostics | null>(null);
    const pending = useRef<AbortController | null>(null);
    useEffect(() => {
        const available = loadChatSessions().filter(s => s.isGroup || resolveSessionCharacterId(s));
        setSessions(available); setSessionId(available[0]?.id ?? ''); setPaused(loadMemoryConfig().automaticWritesPaused === true);
        const onStatus = (event: Event) => { if ((event as CustomEvent<string>).detail) setNotice((event as CustomEvent<string>).detail); };
        window.addEventListener('float:consolidation', onStatus);
        return () => { pending.current?.abort(); window.removeEventListener('float:consolidation', onStatus); };
    }, []);
    const session = sessions.find(s => s.id === sessionId);
    const scope = useMemo<ConsolidationScope | null>(() => session ? { kind: session.isGroup ? 'group_chat' : 'chat', sessionId: session.id, actorId: session.isGroup ? 'group' : resolveSessionCharacterId(session) ?? '' } : null, [session]);
    const refresh = useCallback(async (signal?: AbortSignal) => {
        if (!scope) return;
        const result = await observeConsolidation(scope, signal); setStatus(result.status); setDraft(result.status.config);
        setDiagnostics(await readConsolidationDiagnostics(scope));
    }, [scope]);
    useEffect(() => {
        const controller = new AbortController(); setStatus(null); setDraft(null); setError('');
        void refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '进度读取失败。'); });
        return () => controller.abort();
    }, [refresh]);
    const act = async (action: 'refresh' | 'save' | 'queue' | 'now' | 'resume' | 'abandon') => {
        if (!scope || !session) return;
        const controller = new AbortController(); pending.current = controller; setBusy(true); setError(''); setNotice('');
        try {
            if (action === 'save' && draft && status) await consolidationCall(scope, 'configure', { config: draft, version: status.version }, controller.signal);
            if (action === 'queue') { await consolidationCall(scope, 'queue', {}, controller.signal); setNotice('已排入下一次自然聊天；现在不会调用模型。'); }
            if (action === 'now') { await (await import('@/lib/chat-engine')).runImmediateConsolidation(session, controller.signal); setNotice('本次立即整理已结束，请查看进度与正式记忆。'); }
            if (action === 'resume' || action === 'abandon') await resumeConsolidation(scope, action === 'abandon');
            await refresh(controller.signal);
        } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '操作未确认，进度仍保留。'); else setNotice('已停止本机生成。已提交的写入仍按同一任务核对，不会清零重做。'); }
        finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
    };
    const number = (key: keyof ConsolidationConfig, label: string, min: number, max: number) => draft && <label className={styles.toggleRow}><span>{label}</span><input className={styles.settingControl} aria-label={label} type="number" min={min} max={max} style={{ width: 95, height: 34 }} value={String(draft[key])} onChange={event => setDraft({ ...draft, [key]: Number(event.target.value) })} /></label>;
    const chars = loadCharacters();
    return <section className={styles.root} aria-label="共享对话整理"><div className={styles.body}>
        <div className={styles.toolbar}><h3 className={styles.sectionTitle}>把值得记住的，慢慢留下</h3><span className={styles.badge}>当前聊天模型</span></div>
        <p className={styles.intro}>达到阈值后，在下一次正常回复里一起判断；没有值得留下的事，也可以不新增记忆。原聊天始终保留。</p>
        <label className={styles.muted}>整理哪个对话<select aria-label="整理对话" className={styles.settingControl} style={{ width: '100%', marginTop: 8 }} value={sessionId} disabled={busy} onChange={event => setSessionId(event.target.value)}><option value="" disabled>请选择已有对话</option>{sessions.map(item => <option key={item.id} value={item.id}>{item.isGroup ? item.groupName || '群聊' : chars.find(c => c.id === resolveSessionCharacterId(item))?.name || '私聊'} · {item.id.slice(-6)}</option>)}</select></label>
        {!session && <p className={styles.muted}>先创建一个聊天，再设置它的整理节奏。</p>}
        {status && draft && <>
            <p className={styles.notice} role="status">{status.due ? '待整理 · 等下一次回复' : '正在积累'} · {status.count} / {status.config.count} {status.config.unit === 'user_turns' ? '用户发送轮' : '消息组'} · 估算 {status.tokens} token</p>
            <p className={styles.muted}>待处理 {status.pending} 组，其中 {status.dirty} 组为旧消息变更。用户发送一次计一轮；消息组模式中，用户发送与同轮每位角色的回复各计一组，回复分段不重复计数。</p>
            <progress aria-label="整理阈值进度" max={status.config.count} value={Math.min(status.count, status.config.count)} style={{ width: '100%', accentColor: '#c4a7d2' }} />
            <label className={styles.toggleRow}><span>达到阈值后自动整理</span><input type="checkbox" checked={draft.automatic} onChange={e => setDraft({ ...draft, automatic: e.target.checked })} /></label>
            <label className={styles.toggleRow}><span>允许手动整理</span><input type="checkbox" checked={draft.manual} onChange={e => setDraft({ ...draft, manual: e.target.checked })} /></label>
            <label className={styles.toggleRow}><span style={{ whiteSpace: 'nowrap' }}>计数单位</span><select aria-label="计数单位" className={styles.settingControl} style={{ width: 160 }} value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value as ConsolidationConfig['unit'] })}><option value="user_turns">用户发送轮</option><option value="message_groups">消息组</option></select></label>
            {number('count', '计数阈值', 1, 10000)}{number('tokenThreshold', 'token阈值（0关闭）', 0, 2000000)}
            <details className={styles.fold}><summary>续聊摘要与窗口预算</summary>
                <p className={styles.intro}>摘要是这段对话的压缩缓存，正式记忆只保存有逐字证据的少量事实。只替换摘要覆盖的旧消息；最近对话仍保留，超出模型窗口会明确停止。输入 token 是估算。</p>
                <label className={styles.toggleRow}><span>启用续聊压缩缓存</span><input type="checkbox" checked={draft.compression} onChange={e => setDraft({ ...draft, compression: e.target.checked })} /></label>
                {number('recentGroups', '保留最近消息组', 1, 200)}{number('recentTokens', '近期文字目标token', 256, 100000)}{number('taskTokens', '每批整理输入token', 512, 50000)}{number('summaryChars', '摘要字数上限', 200, 12000)}
                <p className={styles.muted}>请在当前聊天 API 设置中填写实际模型上下文窗口。近期目标受完整请求窗口限制，不能突破硬上限；工具循环仍可能多次生成，embedding 另有请求。</p>
                <p className={styles.muted}>有效摘要 {status.summary.length} 段 · 上次成功：{status.lastSuccess ? new Date(status.lastSuccess.at * 1000).toLocaleString() + ` · ${status.lastSuccess.facts}条事实` : '尚无'}</p>
                {status.summary.map((segment, index) => <p key={index} className={styles.intro}>{segment.text}<small className={styles.muted}> · {segment.sources.length} 个来源组</small></p>)}
                {diagnostics && <p className={styles.muted}>最近本机请求诊断：有效来源 {diagnostics.sourceGroups ?? '未知'} 组，摘要 {diagnostics.summarySegments ?? 0} 段替换 {diagnostics.excludedMessages ?? 0} 条旧消息；输入估算 {diagnostics.input ?? '未知'}、回复预留 {diagnostics.reserve ?? '未知'}、窗口 {diagnostics.window ?? '未知'} token。旧消息仅在来源哈希仍一致且不在近期保留区时被替换。</p>}
            </details>
            <div className={styles.actions}><button className={styles.primary} disabled={busy} onClick={() => void act('save')}>保存这段对话的设置</button><button className={styles.button} disabled={busy || !status.config.manual} onClick={() => void act('queue')}>下次回复整理</button><button className={styles.button} disabled={busy || !status.config.manual || !status.pending || !!status.active} onClick={() => void act('now')}>立即整理 · 一次模型调用</button></div>
            {status.active && <div><p className={styles.muted}>任务状态：{status.active.state} {status.active.error || ''} · 已有 {status.active.receipts.length} 条写入回执。恢复只续办已保存的决策，不再调用模型。</p><button className={styles.button} disabled={busy} onClick={() => void act('resume')}>恢复同一任务</button><button className={styles.quiet} disabled={busy} onClick={() => void act('abandon')}>结束任务，保留待处理进度</button></div>}
        </>}
        <label className={styles.toggleRow}><span>本设备暂停程序写入</span><input type="checkbox" checked={paused} onChange={event => { setPaused(event.target.checked); saveMemoryConfig({ ...loadMemoryConfig(), automaticWritesPaused: event.target.checked }); }} /></label>
        <div className={styles.actions}><button className={styles.button} disabled={busy || !scope} onClick={() => void act('refresh')}>刷新共享进度</button>{busy && <button className={styles.quiet} onClick={() => pending.current?.abort()}>停止</button>}</div>
        {notice && <p className={styles.notice} role="status">{notice}</p>}{error && <p className={styles.alert} role="alert">{error}</p>}
        <p className={styles.muted}>进度按对话与角色保存在共享后端。跨设备需要相同的对话与消息 ID；缺少原对话时会提示同步，不会把两份独立聊天自动合并。切回本机来源可查看、导出旧数据。</p>
    </div></section>;
}
