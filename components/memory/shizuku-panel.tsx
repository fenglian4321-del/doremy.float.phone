'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { shizukuStatus, shizukuControl } from '@/lib/shizuku-tools';
import { configureShizukuProfile, addShizukuApp, removeShizukuApp, executePersistentShizuku, profilePending, profileReceipt, acknowledgeProfileReceipt, type ShizukuScope } from '@/lib/shizuku-profile';
import styles from './workspace.module.css';
const labels: Record<string, string> = { native_unavailable: '浏览器或旧APK不支持', not_installed: '尚未安装Shizuku', not_running: 'Shizuku尚未启动', permission_required: '等待本人授权', denied: '授权已拒绝', revoked: '授权已撤销', authorized: '已授权，执行通道未连接', connecting: '正在连接执行通道', ready: 'UserService已就绪', disconnected: '执行通道已断开', unsupported: '需要Shizuku 13或以上' };
export function ShizukuPanel({ kind, workspaceId, disabled = false }: { kind: ShizukuScope['mode']; workspaceId: string; task?: string; disabled?: boolean }) {
    const scope = useMemo(() => ({ mode: kind, workspaceId }), [kind, workspaceId]);
    const [status, setStatus] = useState(shizukuStatus), [allowChat, setChat] = useState(true), [allowLaunch, setLaunch] = useState(false), [busy, setBusy] = useState(false), [result, setResult] = useState<unknown>(null), [note, setNote] = useState('启用一次后保存到此手机，后续聊天与工作区可直接使用。');
    const controller = useRef<AbortController | null>(null), initialized = useRef(false);
    const profile = status.profile;
    useEffect(() => {
        const refresh = () => { const next = shizukuStatus(); setStatus(next); if (next.profile && !initialized.current) { initialized.current = true; setChat(next.profile.allowChat); setLaunch(next.profile.allowLaunch); } };
        refresh(); const timer = setInterval(refresh, 1500);
        return () => { clearInterval(timer); controller.current?.abort(); };
    }, []);
    const run = async (action: (signal: AbortSignal) => Promise<unknown>, message: string) => {
        if (controller.current) return;
        const c = new AbortController(); controller.current = c; setBusy(true);
        try { const value = await action(c.signal); if (!c.signal.aborted) { setResult(value); setNote(message); } }
        catch (e) { if (!c.signal.aborted) setNote(e instanceof Error ? e.message : '操作未完成。'); }
        finally { if (controller.current === c) { controller.current = null; setBusy(false); setStatus(shizukuStatus()); } }
    };
    const control = (operation: 'permission' | 'connect' | 'disconnect') => { try { shizukuControl(operation); setStatus(shizukuStatus()); setNote(operation === 'disconnect' ? '已停用持续模式及Float执行通道。' : operation === 'permission' ? '请在手机授权框中确认。已有授权时无需重复申请。' : '正在连接，完成后可测试真实功能。'); } catch (e) { setNote(e instanceof Error ? e.message : '未完成。'); } };
    const test = (action: string, packageName?: string) => void run(signal => executePersistentShizuku(scope, { action, ...(packageName ? { packageName } : {}) }, signal), action === 'launch_app' ? '系统返回启动结果。请在手机核对打开的应用；这不表示已完成应用内任务。' : '已收到Shizuku真实查询结果；本次测试没有调用模型。');
    const pending = profilePending(scope);
    return <details className={styles.card} aria-label="Shizuku执行通道"><summary>Shizuku · 手机助手</summary>
        <p className={styles.notice}>{labels[status.status] || status.status}{status.ready ? ` · ${status.identity} / UID ${status.uid}` : ''}{profile?.enabled ? ' · 持续模式已保存' : ''}</p>
        <div className={styles.row}><button type="button" disabled={!status.supported || disabled || busy || status.ready || status.status === 'authorized' || status.status === 'connecting'} onClick={() => control('permission')}>首次授权</button><button type="button" disabled={!status.supported || disabled || busy || status.ready || status.status === 'connecting'} onClick={() => control('connect')}>连接执行通道</button><button type="button" onClick={() => { controller.current?.abort(); control('disconnect'); }}>停用并断开</button></div>
        {!profile && <p role="status" className={styles.notice}>持续模式需要1.0.36或更新APK，以及配套的新网页。普通浏览器不能控制手机。</p>}
        <p className={styles.notice}>首次需你启动Shizuku并授权Float。启用持续模式后会自动重连，返回聊天或重启Float无需重新授权。手机重启后，非root Shizuku通常仍需你重新启动服务。</p>
        <label className={styles.check}><input type="checkbox" checked={allowChat} disabled={disabled || busy} onChange={e => setChat(e.target.checked)} /><span>允许角色聊天使用（包含群聊）</span></label>
        <label className={styles.check}><input type="checkbox" checked={allowLaunch} disabled={disabled || busy} onChange={e => setLaunch(e.target.checked)} /><span>允许直接打开允许列表中的应用</span></label>
        <button type="button" disabled={disabled || busy || !status.ready || !profile} onClick={() => void run(signal => configureShizukuProfile(scope, { enabled: true, allowChat, allowLaunch }, signal), '持续设置已保存。每条消息无需重复授权；可让角色先查询允许列表，再打开所选应用。')}>{profile?.enabled ? '保存持续设置' : '启用持续模式'}</button>
        <p className={styles.notice}>查询身份、查询所选应用和打开应用已实现。应用名、包名和工具结果会提供给当前对话模型。当前不提供应用内点击、输入、截屏、私有文件或任意shell。</p>
        <div className={styles.row}><button type="button" disabled={disabled || busy || !status.ready || !profile?.enabled || !!pending} onClick={() => test('system_info')}>测试：读取手机系统信息</button><button type="button" disabled={disabled || busy || !status.ready || !profile?.enabled} onClick={() => void run(signal => addShizukuApp(scope, signal), '应用已加入此手机允许列表，后续无需逐次选择。')}>添加允许的应用</button></div>
        {profile?.applications.map(app => <div className={styles.card} key={app.packageName}><strong>{app.label}</strong><p className={styles.notice}>{app.packageName}</p><div className={styles.row}><button type="button" disabled={disabled || busy || !status.ready || !profile.enabled || !!pending} onClick={() => test('app_info', app.packageName)}>查询安装情况</button><button type="button" disabled={disabled || busy || !status.ready || !profile.enabled || !profile.allowLaunch || !!pending} onClick={() => test('launch_app', app.packageName)}>测试打开</button><button type="button" disabled={busy} onClick={() => { try { removeShizukuApp(app.packageName); setStatus(shizukuStatus()); } catch (e) { setNote(e instanceof Error ? e.message : '未移除。'); } }}>移除</button></div><p className={styles.notice}>可对角色说：“打开{app.label}”。</p></div>)}
        {pending && <div className={styles.card}><p role="alert">有一条未确认的操作：{pending.operation}。请先核对手机实际结果，不会自动重做。</p><button type="button" onClick={() => { try { setResult(profileReceipt(scope)); setNote('只查询原回执，没有重做操作。'); } catch (e) { setNote(e instanceof Error ? e.message : '未查询。'); } }}>查询原回执</button><button type="button" disabled={busy} onClick={() => { acknowledgeProfileReceipt(scope); setStatus(shizukuStatus()); setNote('已确认核对结果；旧操作不会重做。'); }}>已核对手机，清除等待标记</button></div>}
        {result !== null && <pre aria-label="Shizuku真实执行结果" className={styles.versionPreview}>{JSON.stringify(result, null, 2)}</pre>}
        {!!profile?.recent.length && <div aria-label="最近Shizuku执行记录"><p className={styles.notice}>最近真实执行记录</p>{profile.recent.slice(0, 5).map(row => <p className={styles.notice} key={row.requestId}>{row.ok ? '✓' : '✕'} {row.label} · {row.operation}{row.code ? ` · ${row.code}` : ''}</p>)}</div>}
        <p role="status" className={styles.notice}>{note}</p>
        <a href="https://shizuku.rikka.app/guide/setup/" target="_blank" rel="noopener noreferrer">Shizuku官方启动说明</a>
    </details>;
}
