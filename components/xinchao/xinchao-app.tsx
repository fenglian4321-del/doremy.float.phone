"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, LockKeyhole, RefreshCw, Waves } from 'lucide-react';
import { PageShell } from '../ui/page-shell';
import { connectXinchaoOwner, fetchXinchaoSnapshot, setXinchaoViewEnabled, xinchaoViewEnabled, XinchaoClientError } from '@/lib/xinchao-client';
import type { XinchaoSnapshot } from '@/lib/xinchao-types';
import { loadChatSessions, resolveSessionCharacterId } from '@/lib/chat-storage';
import { loadCharacters } from '@/lib/character-storage';
import { setXinchaoChatSettings, subscribeXinchaoChat, xinchaoChatSettings, xinchaoChatStatus, type XinchaoChatSettings } from '@/lib/xinchao-chat';
import { checkLastXinchaoFeedback, checkXinchaoFeedbackAvailable, setXinchaoFeedbackSettings, subscribeXinchaoFeedback, xinchaoFeedbackSettings, xinchaoFeedbackStatus, type XinchaoFeedbackSettings } from '@/lib/xinchao-feedback';
import styles from './xinchao.module.css';
import { XinchaoInnerPanel } from './inner-panel';
import { XinchaoProactivePanel } from './proactive-panel';

const time = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });
export function XinchaoApp({ onClose }: { onClose: () => void }) {
    const [enabled, setEnabled] = useState(false), [ready, setReady] = useState(false);
    const [snapshot, setSnapshot] = useState<XinchaoSnapshot | null>(null), [busy, setBusy] = useState(false);
    const [error, setError] = useState(''), [unauthorized, setUnauthorized] = useState(false), [token, setToken] = useState('');
    const [chatSettings, setChatSettings] = useState<XinchaoChatSettings>({ enabled: false, sessionId: '', characterId: '' });
    const [chatChoices, setChatChoices] = useState<{ id: string; characterId: string; label: string }[]>([]), [chatStatus, setChatStatus] = useState('尚未使用心潮聊天状态。');
    const [feedback, setFeedback] = useState<XinchaoFeedbackSettings>({ enabled: false, sessionId: '', characterId: '', revision: '' });
    const [feedbackAvailable, setFeedbackAvailable] = useState(false), [feedbackBusy, setFeedbackBusy] = useState(false), [feedbackNote, setFeedbackNote] = useState('尚未启用对话反馈。');
    useEffect(() => { const update = () => { setFeedback(xinchaoFeedbackSettings()); setFeedbackNote(xinchaoFeedbackStatus()); }; update(); return subscribeXinchaoFeedback(update); }, []);
    const pending = useRef<AbortController | null>(null), generation = useRef(0), allowed = useRef(false);
    const cancel = useCallback(() => { generation.current++; pending.current?.abort(); pending.current = null; }, []);
    const refresh = useCallback(async (ownerToken?: string) => {
        if (!allowed.current) return;
        cancel(); const current = generation.current; const controller = new AbortController(); pending.current = controller;
        setBusy(true); setError(''); setSnapshot(null);
        try {
            if (ownerToken) { await connectXinchaoOwner(ownerToken, controller.signal); setToken(''); }
            if (!allowed.current || current !== generation.current || controller.signal.aborted) return;
            const next = await fetchXinchaoSnapshot(controller.signal);
            if (current === generation.current && allowed.current) { setSnapshot(next); setUnauthorized(false); }
        } catch (cause) {
            if (current === generation.current && allowed.current && !controller.signal.aborted) {
                setError(cause instanceof XinchaoClientError ? cause.message : '连接未完成，请稍后重试。');
                setUnauthorized(cause instanceof XinchaoClientError && cause.unauthorized);
            }
        } finally { if (current === generation.current) setBusy(false); }
    }, [cancel]);
    useEffect(() => {
        allowed.current = xinchaoViewEnabled(); setEnabled(allowed.current); setReady(true);
        if (allowed.current) void refresh();
        return () => { allowed.current = false; cancel(); };
    }, [cancel, refresh]);
    useEffect(() => {
        const characters = loadCharacters();
        setChatChoices(loadChatSessions().filter(session => !session.isGroup && !session.isBlacklisted).flatMap(session => {
            const characterId = resolveSessionCharacterId(session), character = characters.find(item => item.id === characterId);
            return characterId && character ? [{ id: session.id, characterId, label: session.alias || character.name }] : [];
        }));
        const update = () => { setChatSettings(xinchaoChatSettings()); setChatStatus(xinchaoChatStatus()); };
        update(); return subscribeXinchaoChat(update);
    }, []);
    const toggle = (value: boolean) => {
        allowed.current = value; setEnabled(value); setXinchaoViewEnabled(value);
        cancel(); setBusy(false); setSnapshot(null); setError(''); setToken(''); setUnauthorized(false);
        if (value) void refresh();
    };
    return <PageShell title="心潮" onBack={onClose} className={styles.shell}>
        <main className={styles.page}>
            <section className={styles.hero}>
                <div className={styles.eyebrow}><Waves size={15} /> XINCHAO · AN INNER TIDE</div>
                <div className={styles.orbit} aria-hidden="true"><span /><span /><i><Activity size={36} strokeWidth={1} /></i></div>
                <h1>听见此刻的潮汐。</h1>
                <p>让变化有一处安静的落点。<br />在这里查看心潮，按自己的节奏靠近。</p>
                <span className={styles.badge}>{!enabled ? '查看已关闭' : busy ? '正在连接' : snapshot ? '状态连接已建立' : '尚未连通'}</span>
            </section>
            <section className={styles.card}>
                <label className={styles.switchRow}><span><strong>允许 Float 查看</strong><small>打开时读取；之后由你手动刷新</small></span><input type="checkbox" role="switch" aria-label="允许 Float 查看心潮" checked={enabled} disabled={!ready} onChange={e => toggle(e.target.checked)} /></label>
                <p className={styles.note}>关闭后停止本入口的新请求；心潮后台和记忆库照常运行。</p>
            </section>
            {enabled && <>
                <div className={styles.sectionTitle}><h2>此刻 / NOW</h2><button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /> 刷新</button></div>
                {error && <p role="alert" className={styles.error}>{error}</p>}
                {unauthorized && <form className={styles.card} onSubmit={e => { e.preventDefault(); if (token.trim()) void refresh(token.trim()); }}>
                    <label className={styles.identity}><LockKeyhole size={16} /> 验证本人会话<input aria-label="本人访问口令" type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder="共享记忆的本人访问口令" maxLength={512} /></label>
                    <button type="submit" disabled={busy || !token.trim()}>验证并查看 <ArrowUpRight size={14} /></button>
                </form>}
                {snapshot ? <>
                    <section className={styles.now}><span className={styles.eyebrow}>服务原文 · {snapshot.now.available ? '本次读取' : '暂未生成'}</span>
                        {snapshot.now.available ? <p>{snapshot.now.text}</p> : <p>服务本次未提供此刻块（{snapshot.now.reason}）。</p>}
                        <small>此刻版本 {snapshot.now.revision} · {time(snapshot.now.generatedAt)}</small>
                    </section>

                    <p className={styles.timestamp}>4.3.0 · 状态版本 {snapshot.revision}<br />读取于 {time(snapshot.fetchedAt)}{snapshot.lastSettledAt && <><br />最近结算 {time(snapshot.lastSettledAt)}</>}</p>
                </> : !error && <p className={styles.empty}>{busy ? '正在取回这一刻…' : '刷新后显示本次状态。'}</p>}
            </>}
            <XinchaoInnerPanel enabled={enabled} choices={chatChoices} />
            <section className={styles.card}>
                <h2>联动，由你决定</h2>
                <label className={styles.future}><span>生活聊天使用状态<small>本机，仅你明确选择的一个私聊</small></span><input type="checkbox" role="switch" aria-label="生活聊天使用状态" checked={chatSettings.enabled} disabled={!ready || (!chatSettings.enabled && !chatChoices.some(item => item.id === chatSettings.sessionId && item.characterId === chatSettings.characterId))} onChange={event => setXinchaoChatSettings({ ...chatSettings, enabled: event.target.checked })} /></label>
                <label className={styles.binding}>绑定生活私聊<select aria-label="心潮绑定生活私聊" value={chatSettings.sessionId} onChange={event => { const selected = chatChoices.find(item => item.id === event.target.value); setXinchaoChatSettings({ enabled: false, sessionId: selected?.id || '', characterId: selected?.characterId || '' }); }}><option value="">由你选择，不自动绑定</option>{chatSettings.sessionId && !chatChoices.some(item => item.id === chatSettings.sessionId) && <option value={chatSettings.sessionId}>原绑定对话不可用</option>}{chatChoices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <p className={styles.note}>开启后，新用户消息生成前读取一次“此刻”，交给该私聊当前模型作临时参考，不增加模型请求。需要有效本人会话，可在上方打开查看完成验证。失败继续聊天。查看开关与聊天开关独立，关闭不撤回已发送上下文。</p>
                <p className={styles.note} role="status">{chatStatus}</p>
                <label className={styles.future}><span>对话互动反馈<small>独立开关；真实对话在场与普通互动</small></span><input type="checkbox" role="switch" aria-label="对话互动反馈" checked={feedback.enabled} disabled={!ready || (!feedback.enabled && (!feedbackAvailable || !chatChoices.some(item => item.id === feedback.sessionId && item.characterId === feedback.characterId)))} onChange={event => setXinchaoFeedbackSettings({ ...feedback, enabled: event.target.checked })} /></label>
                <label className={styles.binding}>反馈绑定生活私聊<select aria-label="反馈绑定生活私聊" value={feedback.sessionId} onChange={event => { const selected = chatChoices.find(item => item.id === event.target.value); setXinchaoFeedbackSettings({ enabled: false, sessionId: selected?.id || '', characterId: selected?.characterId || '' }); }}><option value="">由你选择，不自动绑定</option>{feedback.sessionId && !chatChoices.some(item => item.id === feedback.sessionId) && <option value={feedback.sessionId}>原绑定对话不可用</option>}{chatChoices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <div className={styles.sectionTitle}><button type="button" disabled={feedbackBusy} onClick={() => { setFeedbackBusy(true); void checkXinchaoFeedbackAvailable().then(available => { setFeedbackAvailable(available); setFeedbackNote(available ? '服务端已配置；选择绑定后可明确开启。' : '服务端尚未启用反馈，当前不会向心潮发送。'); }).catch(() => setFeedbackNote('检查未完成，请先验证本人会话。')).finally(() => setFeedbackBusy(false)); }}>检查对话反馈服务</button><button type="button" disabled={feedbackBusy} onClick={() => void checkLastXinchaoFeedback()}>核对上次反馈</button></div>
                <p className={styles.note}>正常回复后发送去重的在场标识与固定“普通对话”反馈，不含原文，也不判断亲密或争执。心潮按自身规则处理普通互动，可能更新清醒、驱力与作息；不增加分类模型请求。20秒内最多一次，失败不阻断聊天、不自动重发。开关只控制本机及同源页面，不能撤回已发送信号。</p>
                <p className={styles.note} role="status">{feedbackNote}</p>
                <p className={styles.note}>工作区、AI私人空间、群聊和后台唤醒不自动接入；不自动判定互动类型；模拟身体是否用于聊天由你单独选择。</p>
            </section>
            <XinchaoProactivePanel choices={chatChoices} />
        </main>
    </PageShell>;
}
