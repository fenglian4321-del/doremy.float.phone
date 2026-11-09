'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clearDeviceUiPending, deviceUiAvailability, deviceUiCall, deviceUiPending, deviceUiReceipt, requestDeviceUiGrant, revokeDeviceUi, type DeviceUiGrant, type DeviceUiSnapshot } from '@/lib/scoped-device-ui';
import { disablePhoneDeviceTools, enablePhoneDeviceTools, getPhoneDeviceSession, type DeviceUiTrace } from '@/lib/phone-device-tools';
import type { SpaceKind } from '@/lib/workspace-client';
import styles from './workspace.module.css';
export function PhoneDevicePanel({ kind, workspaceId, task, disabled, trace }: { kind: SpaceKind; workspaceId: string; task: string; disabled: boolean; trace: DeviceUiTrace[] }) {
    const scope = useMemo(() => ({ mode: kind, workspaceId }), [kind, workspaceId]);
    const [availability, setAvailability] = useState(deviceUiAvailability), [grant, setGrant] = useState<DeviceUiGrant | null>(null), [snapshot, setSnapshot] = useState<DeviceUiSnapshot | null>(null), [allowActions, setAllowActions] = useState(false), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [note, setNote] = useState('设备授权默认关闭；这里只检查能力，不读取界面。'), [authorizedTask, setAuthorizedTask] = useState('');
    const holder = useRef({ controller: null as AbortController | null, grant: null as DeviceUiGrant | null, generation: 0 });
    useEffect(() => { const state = holder.current; setAvailability(deviceUiAvailability()); return () => { state.generation++; state.controller?.abort(); disablePhoneDeviceTools(scope); if (state.grant) { try { revokeDeviceUi(scope, state.grant.id); } catch { /* expired/closed */ } } state.grant = null; }; }, [scope]);
    useEffect(() => { const active = !!getPhoneDeviceSession(scope); if (enabled && !active) { setGrant(null); setSnapshot(null); holder.current.grant = null; } setEnabled(active); }, [disabled, trace, scope, enabled]);
    const stop = () => { holder.current.generation++; holder.current.controller?.abort(); disablePhoneDeviceTools(scope); if (holder.current.grant) { try { revokeDeviceUi(scope, holder.current.grant.id); } catch { /* permission already gone */ } } holder.current.grant = null; setEnabled(false); setGrant(null); setSnapshot(null); setBusy(false); setNote('本轮设备授权已撤销；已发生的动作不能自动撤回，请核对手机与回执。'); };
    const authorize = async () => {
        stop(); const state = holder.current, generation = ++state.generation, controller = new AbortController(); state.controller = controller; const currentTask = task;
        setBusy(true); setNote('请在手机系统选择器中选应用，并核对原生任务授权框。');
        try { const selected = await requestDeviceUiGrant(scope, allowActions, currentTask, controller.signal); if (generation !== state.generation || controller.signal.aborted) { try { revokeDeviceUi(scope, selected.id); } catch { /* stopped */ } return; } state.grant = selected; setGrant(selected); setAuthorizedTask(currentTask); setNote('应用已授权本次任务；尚未启用AI或读取界面。目标应用会在手机上打开。'); }
        catch (error) { if (generation === state.generation && !controller.signal.aborted) setNote(error instanceof Error ? error.message : '授权未完成。'); }
        finally { if (generation === state.generation) { state.controller = null; setBusy(false); } }
    };
    const observe = async () => { if (!grant) return; const state = holder.current, generation = ++state.generation, controller = new AbortController(); state.controller = controller; setBusy(true); try { const result = await deviceUiCall(scope, grant.id, 'observe', {}, controller.signal); if (generation === state.generation) { setSnapshot(result.snapshot || null); setNote('仅在本页显示已授权应用的结构；没有调用模型或上传到VPS。'); } } catch (error) { if (generation === state.generation) setNote(error instanceof Error ? error.message : '观察未完成。'); } finally { if (generation === state.generation) { state.controller = null; setBusy(false); } } };
    const changed = grant && authorizedTask !== task;
    return <details className={styles.card} aria-label="手机设备界面">
        <summary>手机界面 · 当前任务</summary>
        <p className={styles.notice}>{availability.message} 不需要为此启用 Shizuku；不支持的系统或自绘界面不会假称可操作。</p>
        <label className={styles.check}><input type="checkbox" aria-label="下次设备授权允许操作" checked={allowActions} disabled={busy || disabled || enabled} onChange={event => setAllowActions(event.target.checked)} /><span>下次授权允许点击和输入（输入及风险操作需本机确认）</span></label>
        <div className={styles.row}><button type="button" disabled={busy || disabled || !availability.available || !task.trim() || task.length > 4000} onClick={() => void authorize()}>选择应用并授权当前任务</button><button type="button" onClick={() => setAvailability(deviceUiAvailability())}>检查本机能力</button>{(grant || busy || enabled) && <button type="button" onClick={stop}>停止并撤销设备授权</button>}</div>
        <p className={styles.notice}>先在上方消息框写本次任务（最多4000字），再授权。授权只用于当前空间、所选应用和这段任务文字，10分钟后失效。修改任务后须重新授权。界面内容如用于AI，会发送给本区当前模型API；最终回复仍按本区对话保存。</p>
        {grant && <p className={styles.notice}>已选：{grant.label} · {grant.allowActions ? '允许任务内操作' : '只读'}{changed ? ' · 任务文字已改变，请重新授权' : ''}</p>}
        <label className={styles.check}><input type="checkbox" aria-label="本次新消息使用手机界面工具" checked={enabled} disabled={!enabled && (disabled || busy || !grant || !!changed || !!deviceUiPending(scope))} onChange={event => { if (!event.target.checked) { stop(); return; } if (grant) { try { enablePhoneDeviceTools(scope, grant); setEnabled(true); setNote('仅本次新消息使用手机界面工具；不会同时启用目录、MCP或VPS工具。'); } catch (error) { setNote(error instanceof Error ? error.message : '工具未启用。'); } } }} /><span>本次新消息使用手机界面工具</span></label>
        <div className={styles.row}><button type="button" disabled={busy || disabled || !grant || enabled} onClick={() => void observe()}>仅在本页观察一次</button><button type="button" onClick={() => { try { const result = deviceUiReceipt(scope); setNote(result?.receipt ? `原动作回执：${result.receipt.state === 'requested' ? '已请求，仍需核对实际结果' : '结果不确定，禁止自动重做'}${result.receipt.inputVerified ? '；输入已核对' : ''}` : result ? '原读取状态已核对，没有再次观察或执行。' : '没有本页等待标记。'); } catch (error) { setNote(error instanceof Error ? error.message : '原回执未核对。'); } }}>核对原设备回执</button>{deviceUiPending(scope) && <button type="button" onClick={() => { clearDeviceUiPending(scope); setNote('本页等待标记已清除，不撤销动作或删除原生回执；重新授权前请先人工核对手机。'); }}>核对后清除等待标记</button>}</div>
        <p role="status" className={styles.notice}>{note}</p>
        {snapshot && <details><summary>查看本页临时界面结构{snapshot.limited ? '（有文字长度限制）' : ''}</summary><pre className={styles.versionPreview}>{JSON.stringify({ app: snapshot.appLabel, nodes: snapshot.nodes }, null, 2)}</pre></details>}
        {trace.length > 0 && <ul aria-label="AI设备界面回执">{trace.map((item, index) => <li key={item.id + index}>{item.operation} · {item.ok ? item.operation === 'observe' ? '已观察' : item.verified ? '输入已核对' : '动作已请求，业务结果需核对' : '未确认'}{item.code ? ' · ' + item.code : ''}</li>)}</ul>}
    </details>;
}
