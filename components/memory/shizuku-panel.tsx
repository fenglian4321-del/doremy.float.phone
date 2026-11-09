'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { shizukuStatus, shizukuControl, probeShizukuIdentity, requestShizukuGrant, revokeShizukuGrant, enableShizukuTools, disableShizukuTools, getShizukuSession, shizukuReceipt, shizukuPending, acknowledgeShizukuReceipt, type ShizukuGrant } from '@/lib/shizuku-tools';
import type { SpaceKind } from '@/lib/workspace-client';
import styles from './workspace.module.css';
const labels: Record<string, string> = { native_unavailable: '浏览器或旧APK不支持', not_installed: '尚未安装Shizuku', not_running: 'Shizuku尚未启动', permission_required: '等待本人授权', denied: '授权已拒绝', revoked: '授权已撤销', authorized: '已授权，执行通道未连接', connecting: '正在连接执行通道', ready: 'UserService已就绪', disconnected: '执行通道已断开', unsupported: 'Shizuku版本过旧，需要13或以上' };
export function ShizukuPanel({ kind, workspaceId, task, disabled }: { kind: SpaceKind; workspaceId: string; task: string; disabled: boolean }) {
    const scope = useMemo(() => ({ mode: kind, workspaceId }), [kind, workspaceId]);
    const [status, setStatus] = useState(shizukuStatus), [grant, setGrant] = useState<ShizukuGrant | null>(null), [authorizedTask, setTask] = useState(''), [launch, setLaunch] = useState(false), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [identityResult, setIdentityResult] = useState<Record<string, unknown> | null>(null), [note, setNote] = useState('默认关闭。不会自动申请授权、启动Shizuku或切换其他执行器。');
    const controller = useRef<AbortController | null>(null), current = useRef<ShizukuGrant | null>(null);
    useEffect(() => {
        const timer = setInterval(() => { setStatus(shizukuStatus()); const session = getShizukuSession(scope); try { if (session) { const live = shizukuStatus(); if (!live.ready || live.epoch !== session.grant.epoch) throw Error(); if (!shizukuPending(scope)) session.check(); } setEnabled(!!session); } catch { disableShizukuTools(scope); setEnabled(false); setNote('连接或授权已改变，原任务停止；请核对回执后重新授权。'); } }, 1500);
        return () => { clearInterval(timer); controller.current?.abort(); disableShizukuTools(scope); if (current.current) { try { revokeShizukuGrant(scope, current.current.id); } catch { /* stopped */ } } };
    }, [scope]);
    const stop = () => { controller.current?.abort(); disableShizukuTools(scope); if (current.current) { try { revokeShizukuGrant(scope, current.current.id); } catch { /* stopped */ } } current.current = null; setGrant(null); setEnabled(false); setIdentityResult(null); };
    const control = (op: 'permission' | 'connect' | 'disconnect') => { try { if (op === 'disconnect') stop(); shizukuControl(op); setStatus(shizukuStatus()); setNote(op === 'permission' ? '请在手机的Shizuku授权框核对，拒绝不会执行。' : op === 'connect' ? '连接UserService后会核对真实shell/root身份。' : '只停止Float执行通道，不停止全局Shizuku服务。'); } catch (e) { setNote(e instanceof Error ? e.message : '未完成。'); } };
    const probe = async () => { const c = new AbortController(); controller.current = c; setBusy(true); try { const data = await probeShizukuIdentity(scope, c.signal); if (!c.signal.aborted) { setIdentityResult(data); setNote('这份结果由Shizuku UserService实际执行返回，仅在本页显示，没有调用模型。'); } } catch (e) { if (!c.signal.aborted) setNote(e instanceof Error ? e.message : '读取未完成。'); } finally { if (controller.current === c) { controller.current = null; setBusy(false); } } };
    const authorize = async () => {
        stop(); const c = new AbortController(); controller.current = c; setBusy(true);
        try { const chosen = await requestShizukuGrant(scope, task, launch, c.signal); if (c.signal.aborted) { try { revokeShizukuGrant(scope, chosen.id); } catch { /* stopped */ } return; } current.current = chosen; setGrant(chosen); setTask(task); setNote('所选应用已授权当前任务；尚未调用模型或启动应用。'); }
        catch (e) { if (!c.signal.aborted) setNote(e instanceof Error ? e.message : '未完成。'); }
        finally { if (controller.current === c) { controller.current = null; setBusy(false); } }
    };
    return <details className={styles.card} aria-label="Shizuku执行通道"><summary>Shizuku · 独立执行通道</summary>
        <p className={styles.notice}>{labels[status.status] || status.status}{status.ready ? ` · ${status.identity} / UID ${status.uid}` : ''}</p>
        <div className={styles.row}><button type="button" disabled={!status.supported || disabled || busy} onClick={() => control('permission')}>申请Shizuku授权</button><button type="button" disabled={!status.supported || disabled || busy} onClick={() => control('connect')}>连接执行通道</button><button type="button" onClick={() => control('disconnect')}>停止执行通道</button><button type="button" onClick={() => setStatus(shizukuStatus())}>刷新状态</button></div>
        <p className={styles.notice}>需你自行安装并启动Shizuku。非root通常以shell UID2000运行；root会明确显示UID0。不同Android/厂商可能拒绝应用查询或启动，会返回失败。当前不支持任意shell、私有文件、截屏或输入。</p>
        <a href="https://shizuku.rikka.app/guide/setup/" target="_blank" rel="noopener noreferrer">Shizuku官方启动说明</a>
        <label className={styles.check}><input type="checkbox" checked={launch} disabled={disabled || busy || enabled} onChange={e => setLaunch(e.target.checked)} /><span>下次任务允许启动所选应用（每次仍需手机确认）</span></label>
        <div className={styles.row}><button type="button" disabled={disabled || busy || !status.ready || !task.trim() || task.length > 4000} onClick={() => void authorize()}>选择应用并授权此任务</button><button type="button" onClick={stop}>停止并撤销任务授权</button></div>
        {grant && <p className={styles.notice}>当前：{grant.label} · {grant.allowLaunch ? '查询/确认后启动' : '只读查询'}{authorizedTask !== task ? ' · 任务已改变，需重新授权' : ''}</p>}
        <label className={styles.check}><input type="checkbox" aria-label="本次新消息使用Shizuku工具" checked={enabled} disabled={!enabled && (disabled || busy || !grant || authorizedTask !== task || !status.ready || !!shizukuPending(scope))} onChange={e => { if (!e.target.checked) { stop(); return; } try { if (grant) { enableShizukuTools(scope, grant); setEnabled(true); setNote('仅本次新消息提供实际已实现的Shizuku工具，直接使用当前模型。'); } } catch (error) { setNote(error instanceof Error ? error.message : '未启用。'); } }} /><span>本次新消息使用Shizuku工具</span></label>
        <div className={styles.row}><button type="button" onClick={() => { try { const r = shizukuReceipt(scope); setNote(r?.receipt ? `原Shizuku回执：${r.receipt.state}；没有重做操作。` : '没有等待中的回执。'); } catch (e) { setNote(e instanceof Error ? e.message : '未核对。'); } }}>核对原执行回执</button>{shizukuPending(scope) && <button type="button" onClick={() => { acknowledgeShizukuReceipt(scope); setNote('仅清除本页等待标记，保留原生防重回执；旧任务不会重做。'); }}>人工核对后清除等待标记</button>}</div>
        <button type="button" disabled={disabled || busy || !status.ready} onClick={() => void probe()}>读取一次执行身份</button>{identityResult && <pre aria-label="Shizuku真实执行结果" className={styles.versionPreview}>{JSON.stringify(identityResult, null, 2)}</pre>}
        <p role="status" className={styles.notice}>{note}</p>
    </details>;
}
