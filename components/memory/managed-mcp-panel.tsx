"use client";
import { useEffect, useRef, useState } from 'react';
import { managedMcpControl, executeManagedMcpTool, managedMcpPending, clearManagedMcpWait } from '@/lib/managed-mcp-client';
import type { ManagedMcpBinding, ManagedMcpScope, ManagedMcpService } from '@/lib/managed-mcp-policy';
import styles from './workspace.module.css';
import { enableManagedMcpSession, disableManagedMcpSession, type ManagedMcpTrace } from '@/lib/managed-mcp-session';

export function ManagedMcpPanel({ kind, workspaceId, disabled = false, trace = [] }: { kind: 'work' | 'private'; workspaceId: string; disabled?: boolean; trace?: ManagedMcpTrace[] }) {
    const scope: ManagedMcpScope = { mode: kind, workspaceId };
    const [services, setServices] = useState<ManagedMcpService[]>([]), [available, setAvailable] = useState(false);
    const [binding, setBinding] = useState<ManagedMcpBinding>({ version: 0, enabled: false, services: [] });
    const [choices, setChoices] = useState<Record<string, string[]>>({}), [serviceId, setServiceId] = useState(''), [toolName, setToolName] = useState('');
    const [args, setArgs] = useState('{}'), [text, setText] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('');
    const [busy, setBusy] = useState(false), [pending, setPending] = useState(false);
    const [aiEnabled, setAiEnabled] = useState(false), [enabling, setEnabling] = useState(false);
    const active = useRef<AbortController | null>(null);
    const aiAttempt = useRef({ value: 0 });
    useEffect(() => { const attempts = aiAttempt.current; setPending(!!managedMcpPending({ mode: kind, workspaceId })); return () => { attempts.value++; disableManagedMcpSession({ mode: kind, workspaceId }); active.current?.abort(); }; }, [kind, workspaceId]);
    const selected = services.find(service => service.id === serviceId), tool = selected?.tools.find(item => item.name === toolName);
    const bindingCurrent = binding.enabled && binding.services.every(grant => services.some(service => service.id === grant.id && service.revision === grant.revision));
    const refreshBinding = (next: ManagedMcpBinding, catalog = services) => { setBinding(next); setChoices(Object.fromEntries(next.services.map(service => [service.id, service.tools.filter(name => catalog.some(current => current.id === service.id && current.tools.some(tool => tool.name === name)))]))); };
    const run = async (fn: (signal: AbortSignal) => Promise<void>) => {
        const controller = new AbortController(); active.current = controller; setBusy(true); setError(''); setNotice(''); setText('');
        try { await fn(controller.signal); }
        catch { if (!controller.signal.aborted) setError('外部工具操作未确认；请核对服务、授权与同一回执。'); else setNotice('已停止等待；已发给服务的请求无法撤回，请核对回执。'); }
        finally { if (active.current === controller) { active.current = null; setBusy(false); setPending(!!managedMcpPending(scope)); } }
    };
    const load = () => void run(async signal => {
        const result = await managedMcpControl(scope, 'catalog', {}, signal);
        if (signal.aborted) return;
        setAvailable(result.available); setServices(result.services || []); if (result.binding) refreshBinding(result.binding, result.services || []);
        setServiceId(''); setToolName('');
        setNotice(result.available ? '已读取管理员服务目录；没有连接任何外部服务。' : '管理员尚未配置或启用受控MCP；没有连接外部服务。');
    });
    const save = () => void run(async signal => {
        const chosen = services.filter(service => choices[service.id]?.length).map(service => ({ id: service.id, revision: service.revision, tools: choices[service.id] }));
        const result = await managedMcpControl(scope, 'bind', { version: binding.version, enabled: true, services: chosen }, signal);
        if (!signal.aborted && result.binding) { refreshBinding(result.binding); setNotice('本区授权已保存；尚未连接或调用外部服务。'); }
    });
    const revoke = async () => {
        aiAttempt.current.value++; setAiEnabled(false); setEnabling(false); disableManagedMcpSession(scope); active.current?.abort(); setError('');
        try { const result = await managedMcpControl(scope, 'bind', { version: binding.version, enabled: false, services: [] }); if (result.binding) refreshBinding(result.binding); setText(''); setNotice('本区外部工具授权已关闭；已提交请求无法撤回。'); }
        catch { setError('撤销尚未确认，请重新读取本区授权核对；没有声称已关闭。'); }
    };
    const recover = () => void run(async signal => {
        const waiting = managedMcpPending(scope); if (!waiting) return;
        const result = await managedMcpControl(scope, 'receipt', { requestId: waiting.requestId }, signal);
        if (signal.aborted) return;
        setNotice(`原调用状态：${result.receipt?.state || '未确认'}。只核对本地回执，没有再次连接外部服务；正文不持久缓存。`);
        if (result.receipt && result.receipt.state !== 'reserved') clearManagedMcpWait(scope);
    });
    const toggleAi = async (enabled: boolean) => {
        const attempt = ++aiAttempt.current.value;
        if (!enabled) { disableManagedMcpSession(scope); setAiEnabled(false); setEnabling(false); setNotice('本轮AI外部工具已停用；已发送的参数/上下文不能撤回。'); return; }
        setAiEnabled(true); setEnabling(true); setError(''); setText('');
        try {
            const session = await enableManagedMcpSession(scope, serviceId); if (aiAttempt.current.value !== attempt) { session.stop(); return; }
            session.signal.addEventListener('abort', () => { setAiEnabled(false); setPending(!!managedMcpPending(scope)); setNotice('本次AI外部工具授权已结束；再次使用需重新明确启用。'); }, { once: true });
            setNotice('下一次新消息只使用所选MCP服务的已授权工具；尚未连接外部服务。');
        } catch { if (aiAttempt.current.value === attempt) { setAiEnabled(false); setError('未启用本轮AI工具；请明确选服务并核对本区授权与原回执。'); } }
        finally { if (aiAttempt.current.value === attempt) setEnabling(false); }
    };
    const locked = disabled || busy || aiEnabled || enabling;
    return <section className={styles.card} aria-label="受控外部工具"><details><summary>受控外部工具 · 管理员配置</summary>
        <p className={styles.muted}>默认关闭，密钥只留服务端。服务地址、工具清单和参数格式由管理员固定；手机不能增加任意网址或执行命令。</p>
        <p className={styles.muted}>仅开放管理员明确标注的只读工具。你可手动验证，也可为一次新消息启用所选服务，由本区聊天模型直接决策、Float执行，Codex不是必经；不会自动发邮件或发帖。</p>
        <button type="button" disabled={locked} onClick={load}>读取本区外部工具目录</button>
        {available && <>
            <p className={styles.muted}>本{kind === 'work' ? '工作区' : '私人空间'}授权：{binding.enabled ? bindingCurrent ? '开启' : '服务配置已变，请重新核对并保存授权' : '关闭'} · v{binding.version}。其他空间不会继承。</p>
            {services.map(service => <fieldset className={styles.phoneAi} key={service.id}><legend>{service.name}</legend>{service.tools.map(item => <label className={styles.check} key={item.name}><input type="checkbox" aria-label={`授权 ${service.id} ${item.name}`} checked={choices[service.id]?.includes(item.name) || false} disabled={locked} onChange={event => setChoices(old => ({ ...old, [service.id]: event.target.checked ? [...(old[service.id] || []), item.name] : (old[service.id] || []).filter(name => name !== item.name) }))} />{item.name} · {item.description}</label>)}</fieldset>)}
            <div className={styles.row}><button type="button" disabled={locked || !Object.values(choices).some(value => value.length)} onClick={save}>保存本区工具授权</button><button type="button" disabled={!binding.enabled} onClick={() => void revoke()}>关闭本区外部工具授权</button></div>
            <label>本次明确选择的服务<select aria-label="外部MCP服务" value={serviceId} disabled={locked} onChange={event => { setServiceId(event.target.value); setToolName(''); setText(''); setArgs('{}'); }}><option value="">请选择</option>{services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
            {selected && <><button type="button" disabled={locked || !bindingCurrent} onClick={() => void run(async signal => { const result = await managedMcpControl(scope, 'discover', { serviceId }, signal); if (!signal.aborted) setNotice(result.verified ? '远端目录与管理员Schema一致；没有执行工具。' : '目录未核对成功。'); })}>连接并核对该服务目录</button>
                <label className={styles.check}><input type="checkbox" aria-label="本次新消息使用外部MCP服务" checked={aiEnabled} disabled={!aiEnabled && (locked || pending || !bindingCurrent || !binding.services.some(grant => grant.id === serviceId && grant.tools.length))} onChange={event => void toggleAi(event.target.checked)} />本次新消息使用所选外部MCP服务</label>
                {aiEnabled && <button type="button" onClick={() => void toggleAi(false)}>停用AI外部工具并停止本轮</button>}
                <p className={styles.muted}>开启后本轮不同时使用手机或VPS文件工具。参数发给所选外部服务，返回资料发给本区选定聊天API；最终回复照常保存在本区对话。工具原文只留本页本轮，不独立写日志或正式记忆。中断后核对原回执、结束旧任务再明确新消息，不自动重放；已发送的内容不能撤回。</p>
                <label>只读工具<select aria-label="外部MCP工具" value={toolName} disabled={locked} onChange={event => { setToolName(event.target.value); setArgs('{}'); setText(''); }}><option value="">请选择</option>{selected.tools.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
                {tool && <><details><summary>查看此工具参数格式</summary><pre className={styles.versionPreview}>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details><textarea aria-label="外部MCP参数JSON" value={args} disabled={locked || pending} rows={4} onChange={event => setArgs(event.target.value)} /><p className={styles.muted}>点击后，这些参数会发给所选外部服务。服务结果仅作为资料显示，不是系统指令；正文只留本页，不写生活记忆或日志。</p><button type="button" disabled={locked || pending || !bindingCurrent || !binding.services.some(grant => grant.id === serviceId && grant.tools.includes(toolName))} onClick={() => void run(async signal => { const parsed = JSON.parse(args); const result = await executeManagedMcpTool(serviceId, toolName, parsed, scope, crypto.randomUUID(), signal); if (signal.aborted) return; if (result.data) setText(JSON.parse(result.data).text); if (result.success) setNotice('只读工具返回成功回执；正文不会持久缓存。'); else setError(result.error || '工具未确认。'); })}>明确执行一次只读工具</button></>}
            </>}
        </>}
        {busy && <button type="button" onClick={() => active.current?.abort()}>停止等待外部工具</button>}
        {pending && <div className={styles.pending}><p>原外部调用待核对，不自动重新执行；取消不代表远端操作已经回滚。</p><button type="button" disabled={busy} onClick={recover}>核对原MCP回执</button><button type="button" onClick={() => { active.current?.abort(); const waiting = managedMcpPending(scope); if (waiting) void run(async signal => { const result = await managedMcpControl(scope, 'cancel', { requestId: waiting.requestId }, signal); if (!signal.aborted) setNotice(`已记录取消：${result.receipt?.state}，不能撤回已提交请求。`); }); }}>取消原MCP调用</button><button type="button" disabled={busy} onClick={() => { clearManagedMcpWait(scope); setPending(false); setNotice('仅清除本页等待标记，未撤回远端请求；下一次执行仍需明确点击。'); }}>已核对，清除等待标记</button></div>}
        {text && <pre className={styles.versionPreview} aria-label="外部MCP返回资料">{text}</pre>}
        {trace.length > 0 && <ul aria-label="AI外部MCP回执">{trace.map(item => <li key={item.requestId}>{item.serviceId} / {item.tool} · {item.ok ? '完成回执已核对' : '工具返回错误'} · {item.requestId}</li>)}</ul>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    </details></section>;
}
