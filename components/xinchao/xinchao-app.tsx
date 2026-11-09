"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, LockKeyhole, RefreshCw, Waves } from 'lucide-react';
import { PageShell } from '../ui/page-shell';
import { connectXinchaoOwner, fetchXinchaoSnapshot, setXinchaoViewEnabled, xinchaoViewEnabled, XinchaoClientError } from '@/lib/xinchao-client';
import type { XinchaoSnapshot } from '@/lib/xinchao-types';
import { loadChatSessions, resolveSessionCharacterId } from '@/lib/chat-storage';
import { loadCharacters } from '@/lib/character-storage';
import { setXinchaoChatSettings, subscribeXinchaoChat, xinchaoChatSettings, xinchaoChatStatus, type XinchaoChatSettings } from '@/lib/xinchao-chat';
import styles from './xinchao.module.css';

const time = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });
export function XinchaoApp({ onClose }: { onClose: () => void }) {
    const [enabled, setEnabled] = useState(false), [ready, setReady] = useState(false);
    const [snapshot, setSnapshot] = useState<XinchaoSnapshot | null>(null), [busy, setBusy] = useState(false);
    const [error, setError] = useState(''), [unauthorized, setUnauthorized] = useState(false), [token, setToken] = useState('');
    const [chatSettings, setChatSettings] = useState<XinchaoChatSettings>({ enabled: false, sessionId: '', characterId: '' });
    const [chatChoices, setChatChoices] = useState<{ id: string; characterId: string; label: string }[]>([]), [chatStatus, setChatStatus] = useState('尚未使用心潮聊天状态。');
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
                <span className={styles.badge}>{!enabled ? '查看已关闭' : busy ? '正在连接' : snapshot ? '只读连接已建立' : '尚未连通'}</span>
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
                    <section className={styles.card}><div className={styles.sectionTitle}><h2>状态切片</h2><span>{snapshot.consciousness === 'awake' ? '醒着' : snapshot.consciousness === 'sleeping' ? '休息中' : snapshot.consciousness}</span></div>
                        <div className={styles.drives}>{snapshot.drives.map(d => <div key={d.key}><span>{d.label}</span><meter min={0} max={1} value={d.value} aria-label={d.label} /><small>{Math.round(d.value * 100)}%</small></div>)}</div>
                        <p className={styles.note}>只展示已有状态。数值是引擎记录，不用于推断现实关系。</p>
                    </section>
                    <p className={styles.timestamp}>4.3.0 · 状态版本 {snapshot.revision}<br />读取于 {time(snapshot.fetchedAt)}{snapshot.lastSettledAt && <><br />最近结算 {time(snapshot.lastSettledAt)}</>}</p>
                </> : !error && <p className={styles.empty}>{busy ? '正在取回这一刻…' : '刷新后显示本次状态。'}</p>}
            </>}
            <section className={styles.card}>
                <h2>联动，由你决定</h2>
                <label className={styles.future}><span>生活聊天使用状态<small>本机，仅你明确选择的一个私聊</small></span><input type="checkbox" role="switch" aria-label="生活聊天使用状态" checked={chatSettings.enabled} disabled={!ready || (!chatSettings.enabled && !chatChoices.some(item => item.id === chatSettings.sessionId && item.characterId === chatSettings.characterId))} onChange={event => setXinchaoChatSettings({ ...chatSettings, enabled: event.target.checked })} /></label>
                <label className={styles.binding}>绑定生活私聊<select aria-label="心潮绑定生活私聊" value={chatSettings.sessionId} onChange={event => { const selected = chatChoices.find(item => item.id === event.target.value); setXinchaoChatSettings({ enabled: false, sessionId: selected?.id || '', characterId: selected?.characterId || '' }); }}><option value="">由你选择，不自动绑定</option>{chatSettings.sessionId && !chatChoices.some(item => item.id === chatSettings.sessionId) && <option value={chatSettings.sessionId}>原绑定对话不可用</option>}{chatChoices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <p className={styles.note}>开启后，新用户消息生成前读取一次“此刻”，交给该私聊当前模型作临时参考，不增加模型请求。需要有效本人会话，可在上方打开查看完成验证。失败继续聊天。查看开关与聊天开关独立，关闭不撤回已发送上下文。</p>
                <p className={styles.note} role="status">{chatStatus}</p>
                {['对话互动反馈', '主动消息'].map(label => <label key={label} className={styles.future}><span>{label}<small>后续接入，当前关闭</small></span><input type="checkbox" role="switch" aria-label={label} checked={false} disabled readOnly /></label>)}
                <p className={styles.note}>工作区、AI私人空间、群聊和后台唤醒不自动接入；当前不回报对话或开启身体模拟。</p>
            </section>
        </main>
    </PageShell>;
}
