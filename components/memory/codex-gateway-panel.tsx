"use client";
import { useEffect, useRef, useState } from 'react';
import { checkCodexGateway } from '@/lib/codex-gateway-client';
import styles from './shared-memory.module.css';

export function CodexGatewayPanel({ shared }: { shared: boolean }) {
    const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
    const [error, setError] = useState(''), [version, setVersion] = useState('');
    const pending = useRef<AbortController | null>(null);
    useEffect(() => () => pending.current?.abort(), [shared]);
    const check = async () => {
        pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
        setBusy(true); setError(''); setReady(false);
        try { const status = await checkCodexGateway(controller.signal); if (!controller.signal.aborted) { setReady(status.available === true); setVersion(status.version ?? ''); } }
        catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '连接检查失败。'); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    return <section className={styles.root} aria-label="Codex 只读工具设置"><div className={styles.body}>
        <details className={styles.fold}><summary>Codex 原型连接诊断</summary>
            <p className={styles.intro}>这是此前两项心潮只读工具的连接原型。日常记忆和 Float 内置工具直接执行，Codex 离线不会阻塞它们。</p>
            <p className={styles.intro}>这里只检查连接，不会把原型加入聊天。未来扩展优先复用现有 MCP 与现实桥；具体插件仍需验证宿主兼容性。</p>
            <button type="button" className={styles.button} onClick={check} disabled={busy}>{busy ? '正在检查…' : '检查工具连接'}</button>
            {ready && <p role="status" className={styles.notice}>原型连接可用 · Codex {version}</p>}
            {error && <p role="alert" className={styles.alert}>{error}</p>}
            <p className={styles.intro}>本原型不表示已接通邮件、小红书、花园、主动消息或任意命令执行。</p>
        </details>
    </div></section>;
}
