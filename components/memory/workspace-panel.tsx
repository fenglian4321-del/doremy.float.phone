"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadApiConfigs, saveApiConfigs } from '@/lib/settings-storage';
import type { ApiConfig } from '@/lib/settings-types';
import { connectWorkspaceOwner, registerWorkspaceAssistant, stopWorkspaceAssistant, endWorkspaceRun, runWorkspaceChat, compressWorkspaceContext, spaceCall, workspaceReceipt, type Workspace, type WorkspaceResult, type WorkspaceTrace, type SpaceKind, type AttachmentRef, type SpaceFileHistory } from '@/lib/workspace-client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowUp, ArrowUpRight, MessageSquare, PanelLeft, Paperclip, Plus, Settings2, Square, SquareTerminal, Wrench, X } from 'lucide-react';
import { FloatToolPanel } from '@/components/workbench/float-tool-panel';
import { WorkspaceAssistantSession, type AssistantApproval, type AssistantTrace } from '@/lib/workspace-assistant-session';
import ui from '@/components/workbench/workbench.module.css';
import { getUsageLedger } from '@/lib/usage-ledger';
import styles from './workspace.module.css';
import { readSpaceTextAttachment } from '@/lib/space-attachments';
import { PhoneDirectoryPanel } from './phone-directory-panel';
import type { PhoneToolTrace } from '@/lib/phone-file-tools';
import { ManagedMcpPanel } from './managed-mcp-panel';
import type { ManagedMcpTrace } from '@/lib/managed-mcp-session';
import { PhoneDevicePanel } from './phone-device-panel';
import { ShizukuPanel } from './shizuku-panel';
import type { DeviceUiTrace } from '@/lib/phone-device-tools';

export function WorkspacePanel({ onBack, kind = 'work', onKindChange }: { onBack: () => void; kind?: SpaceKind; onKindChange?: (kind: SpaceKind) => void }) {
    const text = useCallback((value: string) => kind === 'private' ? value.replaceAll('WORK · 独立工作区', 'PRIVATE · AI私人空间').replaceAll('独立工作区', 'AI私人空间').replaceAll('工作助手', '空间里的AI').replaceAll('工作区', '私人空间').replaceAll('工作', '私人') : value, [kind]);
    const call = useCallback((operation: string, payload: Record<string, unknown> = {}, signal?: AbortSignal) => spaceCall(kind, operation, payload, signal), [kind]);
    const [sidebar, setSidebar] = useState(false), [drawer, setDrawer] = useState<'tools' | 'files' | 'context' | null>(null);
    const [selectedFloatTools, setSelectedFloatTools] = useState<string[]>([]), [floatEnabled, setFloatEnabled] = useState(false), [floatCharacter, setFloatCharacter] = useState('');
    const [assistantTrace, setAssistantTrace] = useState<AssistantTrace[]>([]), [approval, setApproval] = useState<AssistantApproval | null>(null);
    const timeline = useRef<HTMLDivElement | null>(null);
    const [selectedAttachments, setSelectedAttachments] = useState<AttachmentRef[]>([]);
    const [folder, setFolder] = useState('all');
    const [spaces, setSpaces] = useState<Workspace[]>([]), [selected, setSelected] = useState('');
    const [workspace, setWorkspace] = useState<Workspace | null>(null), [configs, setConfigs] = useState<ApiConfig[]>([]), [configId, setConfigId] = useState('');
    const [title, setTitle] = useState(''), [draft, setDraft] = useState(''), [token, setToken] = useState('');
    const [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [showArchived, setShowArchived] = useState(false);
    const [filePath, setFilePath] = useState('notes/plan.md'), [fileText, setFileText] = useState(''), [fileVersion, setFileVersion] = useState(0);
    const [calls, setCalls] = useState(0);
    const [trace, setTrace] = useState<WorkspaceTrace[]>([]);
    const [phoneTrace, setPhoneTrace] = useState<PhoneToolTrace[]>([]);
    const [mcpTrace, setMcpTrace] = useState<ManagedMcpTrace[]>([]);
    const [deviceTrace, setDeviceTrace] = useState<DeviceUiTrace[]>([]);
    const [taskKind, setTaskKind] = useState<'chat' | 'compression'>('chat');
    const [summaryDraft, setSummaryDraft] = useState('');
    const [fileBaseline, setFileBaseline] = useState('');
    const [fileHistory, setFileHistory] = useState<SpaceFileHistory | null>(null);
    const [versionPreview, setVersionPreview] = useState<{ path: string; version: number; content: string } | null>(null);
    const restoreKeys = useRef(new Map<string, string>());
    const active = useRef<AbortController | null>(null), createKey = useRef('');
    const config = configs.find(item => item.id === configId);
    const summaryDirty = !!workspace?.context?.summary && summaryDraft !== workspace.context.summary.text;
    const refreshList = useCallback(async (signal?: AbortSignal) => {
        const result = await call('list', {}, signal);
        if (!signal?.aborted) { setSpaces(result.workspaces || []); setSelected(value => value || result.workspaces?.find(w => !w.archived)?.id || ''); }
    }, [call]);
    useEffect(() => {
        const controller = new AbortController(), apis = loadApiConfigs();
        setConfigs(apis); setConfigId(apis[0]?.id || '');
        void refreshList(controller.signal).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : text("工作区尚未就绪。")); setSidebar(true); } });
        return () => { controller.abort(); active.current?.abort(); };
    }, [refreshList, text]);
    useEffect(() => {
        setWorkspace(null); setFloatEnabled(false); setSelectedFloatTools([]); setFloatCharacter(''); setApproval(null); setAssistantTrace([]); setFileText(''); setFileVersion(0); setFilePath('notes/plan.md'); setDraft(''); setNote(''); setTrace([]); setPhoneTrace([]); setMcpTrace([]); setDeviceTrace([]); setSelectedAttachments([]); setFolder('all');
        if (!selected) return;
        const saved = workspaceReceipt(selected, kind);
        setTaskKind(saved?.kind || 'chat'); setFileHistory(null); setVersionPreview(null); setFileBaseline(''); restoreKeys.current.clear();
        if (saved?.configId && loadApiConfigs().some(c => c.id === saved.configId)) setConfigId(saved.configId);
        const controller = new AbortController();
        void call('detail', { workspaceId: selected }, controller.signal).then(result => { if (!controller.signal.aborted) { setWorkspace(result.workspace); setTaskKind(result.run?.kind || saved?.kind || 'chat'); setTrace(result.run?.trace || []); setCalls(getUsageLedger().filter(row => row.source === kind && row.scopeId === selected).length); } }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : text("工作区读取失败。")); });
        return () => { controller.abort(); stopWorkspaceAssistant(kind, selected); };
    }, [selected, kind, call, text]);
    useEffect(() => { setSummaryDraft(workspace?.context?.summary?.text || ''); }, [workspace?.id, workspace?.context?.summary?.version, workspace?.context?.summary?.text]);
    useEffect(() => { if (timeline.current) timeline.current.scrollTo({ top: timeline.current.scrollHeight, behavior: 'smooth' }); }, [workspace?.messages?.length, assistantTrace.length, approval, busy]);
    const apply = (result: WorkspaceResult) => {
        setWorkspace(result.workspace);
        setSelectedAttachments(old => old.filter(ref => result.workspace.files?.some(file => file.path === ref.path && file.version === ref.version)));
        if (result.run) { setTrace(result.run.trace || []); setTaskKind(result.run.kind || 'chat'); }
        setSpaces(old => old.map(w => w.id === result.workspace.id ? result.workspace : w));
        setCalls(getUsageLedger().filter(row => row.source === kind && row.scopeId === result.workspace.id).length);
    };
    const action = async (fn: (signal: AbortSignal) => Promise<void>) => {
        if (active.current) return;
        const controller = new AbortController(); active.current = controller;
        setBusy(true); setError('');
        try { await fn(controller.signal); }
        catch (cause) { if (controller.signal.aborted) setNote(text("已停止。已完成操作保留；手机工具先核对回执，其他工作任务可恢复。")); else setError(cause instanceof Error ? cause.message : text("工作操作未确认。")); }
        finally { if (active.current === controller) { setBusy(false); if (workspace) stopWorkspaceAssistant(kind, workspace.id); setFloatEnabled(false); setApproval(null); active.current = null; } }
    };
    const chat = (resume: boolean) => void action(async signal => {
        if (!workspace || !config) throw new Error(text("请先选择工作区和聊天API。"));
        if (!resume) {
            const assistant = new WorkspaceAssistantSession({ mode: kind, workspaceId: workspace.id }, floatEnabled ? selectedFloatTools : [], floatCharacter || undefined, setApproval);
            registerWorkspaceAssistant(assistant); setAssistantTrace([]); setDrawer(null);
            setPhoneTrace([]); setMcpTrace([]); setDeviceTrace([]); }
        await runWorkspaceChat(workspace, config, resume ? null : draft, signal, (result, message) => {
            if (!signal.aborted) { apply(result); if (!resume) { setDraft(''); setSelectedAttachments([]); } if (message) setNote(message); }
        }, kind, selectedAttachments, item => { if (!signal.aborted) setPhoneTrace(old => [...old, item]); }, item => { if (!signal.aborted) setMcpTrace(old => [...old, item]); }, item => { if (!signal.aborted) setDeviceTrace(old => [...old, item]); }, item => { if (!signal.aborted) setAssistantTrace(old => [...old, item]); });
    });
    const compress = (resume: boolean) => void action(async signal => {
        if (!workspace || !config) throw new Error('请先选择本区与API。');
        await compressWorkspaceContext(workspace, config, resume, signal, (result, message) => { if (!signal.aborted) { apply(result); if (message) setNote(message); } }, kind);
    });
    const resumeTask = () => taskKind === 'compression' ? compress(true) : chat(true);
    const restoreVersion = () => void action(async signal => {
        if (!workspace || !versionPreview || versionPreview.path !== filePath || fileText !== fileBaseline) throw new Error('请先保存当前编辑，再核对要恢复的版本。');
        const marker = JSON.stringify([filePath, fileVersion, versionPreview.version]);
        let clientKey = restoreKeys.current.get(marker);
        if (!clientKey) { clientKey = crypto.randomUUID(); restoreKeys.current.set(marker, clientKey); }
        const restored = await call('restore_file', { workspaceId: workspace.id, path: filePath, baseVersion: fileVersion, targetVersion: versionPreview.version, clientKey }, signal);
        const current = await call('read_file', { workspaceId: workspace.id, path: filePath }, signal);
        apply(current);
        if (current.result) { setFileText(current.result.content); setFileBaseline(current.result.content); setFileVersion(current.result.version); }
        setFileHistory(null); setVersionPreview(null);
        setNote(restored.restored?.version === current.result?.version ? '旧内容已恢复为新版本，原版本仍保留。' : '恢复回执已确认；文件随后又被修改，编辑器显示当前新版。');
    });
    const exportWork = () => void action(async signal => {
        if (!workspace) return;
        const current = await call('detail', { workspaceId: workspace.id }, signal);
        const files = [];
        for (const file of current.workspace.files || []) {
            const read = await call('read_file', { workspaceId: workspace.id, path: file.path }, signal);
            if (read.result?.version !== file.version) throw new Error(text("导出期间工作文件改变，请刷新后重试。"));
            files.push(read.result);
        }
        const after = await call('detail', { workspaceId: workspace.id }, signal);
        if (after.workspace.version !== current.workspace.version) throw new Error(text("导出期间工作区改变，请刷新后重试。"));
        const blob = new Blob([JSON.stringify({ format: kind === 'private' ? 'float-private-space-export/v1' : 'float-workspace-export/v1', workspace: current.workspace, files }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `float-${kind}-${workspace.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
        setNote(text("已导出当前工作区；导出不包含生活记忆或模型密钥。"));
    });
    const newConversation = () => void action(async signal => {
        createKey.current ||= crypto.randomUUID(); const result = await call('create', { title: title.trim() || '新对话', clientKey: createKey.current }, signal);
        createKey.current = ''; setTitle(''); setSpaces(old => [result.workspace, ...old.filter(row => row.id !== result.workspace.id)]); setSelected(result.workspace.id); apply(result); setSidebar(false);
    });
    return <main className={`${styles.page} ${ui.app} ${kind === 'private' ? styles.privatePage : ''}`} aria-label="工作区App">
        <header className={ui.header}><button type="button" aria-label="关闭工作区" onClick={() => { active.current?.abort(); onBack(); }}><ArrowLeft size={18} /></button><button type="button" aria-label="打开会话列表" onClick={() => setSidebar(old => !old)}><PanelLeft size={18} /></button><div className={ui.brand}><SquareTerminal size={18} /><span>工作区<small>YOUR AI WORKSPACE</small></span></div><button type="button" aria-label="新建会话" disabled={busy} onClick={newConversation}><Plus size={18} /></button></header>
        <div className={ui.layout}>
            {sidebar && <button className={ui.scrim} type="button" aria-label="收起会话列表" onClick={() => setSidebar(false)} />}
            <aside className={`${ui.sidebar} ${sidebar ? ui.sidebarOpen : ''}`} aria-label="工作会话列表">
                <div className={ui.sideHeading}><span>会话</span><button type="button" onClick={() => setSidebar(false)} aria-label="关闭会话列表"><X size={16} /></button></div>
                {onKindChange && <div className={ui.scopeTabs}><button type="button" disabled={busy} aria-pressed={kind === 'work'} onClick={() => onKindChange('work')}>工作会话</button><button type="button" disabled={busy} aria-pressed={kind === 'private'} onClick={() => onKindChange('private')}>私人笔记</button></div>}
                <input aria-label={text("新工作区名称")} value={title} maxLength={80} placeholder="新会话名称（可选）" disabled={busy} onChange={event => { createKey.current = ''; setTitle(event.target.value); }} />
                <button className={ui.newChat} type="button" disabled={busy} onClick={newConversation}><Plus size={14} />新建会话</button>
                <div className={ui.conversationList}>{spaces.filter(row => showArchived || !row.archived).map(row => <button type="button" key={row.id} aria-current={row.id === selected ? 'page' : undefined} disabled={busy} onClick={() => { setSelected(row.id); setSidebar(false); }}><MessageSquare size={14} /><span>{row.title}<small>{row.archived ? '已归档 · ' : ''}{new Date(row.updatedAt * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</small></span></button>)}{!spaces.length && <p className={ui.quiet}>从一个任务开始。会话记录留在这里。</p>}</div>
                <label className={ui.check}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示归档会话</label>
                <button type="button" disabled={busy} onClick={() => void action(refreshList)}>刷新会话</button>
                <details className={ui.owner}><summary>本人连接</summary><p>使用共享服务的本人会话，工作对话独立保存。</p><input aria-label={text("工作区本人访问口令")} type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="本人访问口令" /><button type="button" disabled={busy || !token.trim()} onClick={() => void action(async signal => { await connectWorkspaceOwner(token); setToken(''); await refreshList(signal); })}>连接</button></details>
            </aside>
            <section className={ui.thread} aria-label={text("独立工作对话")}>
                <div className={ui.threadBar}><div><strong>{workspace?.title || '新的工作会话'}</strong><small>{kind === 'private' ? 'PRIVATE · 私人笔记' : 'WORK · 任务助手'}{workspace?.archived ? ' · 已归档' : ''}</small></div><select aria-label={text("工作聊天API")} value={configId} disabled={busy} onChange={event => setConfigId(event.target.value)}><option value="" disabled>选择模型</option>{configs.map(row => <option key={row.id} value={row.id}>{row.name || row.provider} · {row.defaultModel}</option>)}</select></div>
                <div className={ui.timeline} ref={timeline}>
                    {!workspace?.messages?.length && <div className={ui.welcome}><div className={ui.agentMark}><SquareTerminal size={25} /></div><p>把想做的事，交给这里。</p><span>与 AI 讨论、执行、核对。<br />需要时，在工具抽屉连接真机与 Float 能力。</span>{!workspace && <button type="button" disabled={busy} onClick={newConversation}>开始一个新会话 <ArrowUpRight size={14} /></button>}</div>}
                    {workspace?.messages?.map(message => <article className={`${ui.message} ${message.role === 'user' ? ui.userMessage : ui.assistantMessage}`} key={message.id}><small>{message.role === 'user' ? '你' : 'Float 助手'}</small><div className={ui.messageBody}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => <span>（图片链接，未自动加载）</span> }}>{message.content}</ReactMarkdown></div>{message.attachments?.map(ref => <small key={ref.path}><Paperclip size={10} />{ref.path} · v{ref.version}</small>)}</article>)}
                    {(trace.length > 0 || assistantTrace.length > 0 || phoneTrace.length > 0 || mcpTrace.length > 0 || deviceTrace.length > 0) && <details className={ui.toolEvents} open={busy}><summary><Wrench size={13} />本轮执行记录</summary>{assistantTrace.map((item,index) => <p key={item.id+':'+index}><span className={item.ok ? ui.success : ''}>{item.state === 'approval' ? '等待核对' : item.state === 'complete' ? '已返回' : item.state === 'declined' ? '已取消' : '待核对'}</span> · {item.tool} · {item.location === 'vps' ? '本区文件' : item.location === 'shizuku' ? 'Shizuku真机' : 'Float'}</p>)}{trace.map((item,index) => <p key={'legacy:'+index}>{item.ok ? '本区文件回执已返回' : '文件操作未确认'} · {item.path || '文件工具'}{item.version ? ` · v${item.version}` : ''}</p>)}{phoneTrace.map((item,index) => <p key={'file:'+index}>{item.ok ? '目录回执已返回' : '目录操作未确认'} · {item.operation}</p>)}{deviceTrace.map((item,index) => <p key={'ui:'+index}>{item.ok ? '设备回执已返回' : '设备操作未确认'} · {item.operation}{item.verified ? ' · 输入已核对' : ''}</p>)}{mcpTrace.map((item,index) => <p key={'mcp:'+index}>{item.ok ? '服务回执已返回' : '服务操作未确认'} · {item.tool}</p>)}</details>}
                    {approval && <section className={ui.approval} aria-label="确认Float动作"><strong>助手想调用：{approval.tool}</strong><p>核对这次具体操作；确认只对这一次有效。{approval.target ? ` 操作对象：${approval.target}` : ''}</p><pre>{approval.arguments}</pre><div><button type="button" onClick={() => approval.decide(false)}>取消这次操作</button><button type="button" onClick={() => approval.decide(true)}>确认执行这一次</button></div></section>}
                    {busy && <div className={ui.working} role="status"><span />{approval ? '等待你核对操作' : '正在处理这个任务…'}</div>}
                    {error && <p className={ui.error} role="alert">{error}</p>}{note && <p className={ui.notice} role="status">{note}</p>}
                    {workspace?.activeRun && !busy && <div className={ui.recovery}><p>上次任务还留有记录。已发生的动作会保留，外部动作不会自动重放。</p><button type="button" disabled={!config} onClick={resumeTask}>核对或恢复原任务</button><button type="button" onClick={() => void action(async () => { const known = workspaceReceipt(workspace.id,kind); apply(await endWorkspaceRun(workspace.id,!known?.runId,kind)); setNote('原任务已结束，记录和已完成操作保留。'); })}>结束原任务</button></div>}
                </div>
                <div className={ui.composer}>
                    <div className={ui.composerTools}><button type="button" aria-pressed={drawer === 'tools'} onClick={() => setDrawer(drawer === 'tools' ? null : 'tools')}><Wrench size={13} />工具{floatEnabled ? ` · ${selectedFloatTools.length}` : ''}</button><button type="button" aria-pressed={drawer === 'files'} onClick={() => setDrawer(drawer === 'files' ? null : 'files')}><Paperclip size={13} />文件{selectedAttachments.length ? ` · ${selectedAttachments.length}` : ''}</button><button type="button" aria-pressed={drawer === 'context'} onClick={() => setDrawer(drawer === 'context' ? null : 'context')}><Settings2 size={13} />会话</button></div>
                    <textarea aria-label={text("工作消息")} value={draft} onChange={event => setDraft(event.target.value)} disabled={busy || !workspace || workspace.archived || !!workspace.activeRun} placeholder={workspace ? '描述任务，或接着聊…' : '先开始一个新会话…'} rows={3} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy && draft.trim() && workspace && !workspace.activeRun) { event.preventDefault(); chat(false); } }} />
                    <div className={ui.composerFooter}><span>{selectedAttachments.length ? `${selectedAttachments.length}份附件 · ` : ''}本区独立保存 · {calls} 次请求</span>{busy ? <button type="button" className={ui.send} onClick={() => active.current?.abort()}><Square size={12} />停止</button> : <button type="button" className={ui.send} disabled={!draft.trim() || !config || !workspace || workspace.archived || !!workspace.activeRun} onClick={() => chat(false)} aria-label="发送工作消息"><ArrowUp size={17} /></button>}</div>
                </div>
            </section>
            {workspace && <aside className={ui.drawer} style={{display: drawer ? undefined : 'none'}} aria-label="会话工具抽屉"><div className={ui.sideHeading}><strong>{drawer === 'tools' ? '工具与授权' : drawer === 'files' ? '本区文件' : '会话设置'}</strong><button type="button" onClick={() => setDrawer(null)} aria-label="关闭工具抽屉"><X size={17} /></button></div>
                <div style={{display: drawer === 'tools' ? undefined : 'none'}}>
                    <FloatToolPanel kind={kind} workspaceId={workspace.id} disabled={busy || workspace.archived} enabled={floatEnabled} onEnable={setFloatEnabled} selected={selectedFloatTools} onSelect={setSelectedFloatTools} characterId={floatCharacter} onCharacter={setFloatCharacter} />
                    <PhoneDirectoryPanel key={kind+':'+workspace.id} kind={kind} workspaceId={workspace.id} disabled={busy || workspace.archived} trace={phoneTrace} />
                    <ManagedMcpPanel key={'mcp:'+kind+':'+workspace.id} kind={kind} workspaceId={workspace.id} disabled={busy || workspace.archived} trace={mcpTrace} />
                    <ShizukuPanel key={'shizuku:'+kind+':'+workspace.id} kind={kind} workspaceId={workspace.id} task={draft} disabled={busy || workspace.archived} />
                    <PhoneDevicePanel key={'device:'+kind+':'+workspace.id} kind={kind} workspaceId={workspace.id} task={draft} disabled={busy || workspace.archived} trace={deviceTrace} />
                </div>
                <div style={{display: drawer === 'files' ? undefined : 'none'}}><details><summary>本轮文字附件 · {selectedAttachments.length}/6</summary>
                    <p className={styles.muted}>仅选中的本区文件会随本轮发送，固定所选版本；不会自动读取其他项目或手机目录。</p>
                    <input aria-label="导入文字附件" type="file" accept=".txt,.md,.json,.csv,.log" disabled={busy || workspace.archived} onChange={event => { const input = event.currentTarget, file = input.files?.[0]; if (!file) return; void action(async signal => { try { const item = await readSpaceTextAttachment(file); const result = await call('write_file', { workspaceId: workspace.id, path: item.path, content: item.content, baseVersion: 0 }, signal); apply(result); if (result.result) setSelectedAttachments(old => old.length < 6 ? [...old, { path: result.result!.path, version: result.result!.version }] : old); setNote('文字附件已导入本区；仅勾选项随本轮发送。'); } finally { input.value = ''; } }); }} />
                    {(workspace.files || []).map(file => <label className={styles.check} key={file.path}><input type="checkbox" disabled={busy || workspace.archived} checked={selectedAttachments.some(ref => ref.path === file.path && ref.version === file.version)} onChange={event => { if (event.target.checked && selectedAttachments.length >= 6) { setError('一次最多选择6份文字附件。'); return; } setSelectedAttachments(old => event.target.checked ? [...old.filter(ref => ref.path !== file.path), { path: file.path, version: file.version }] : old.filter(ref => ref.path !== file.path)); }} />{file.path} · v{file.version}</label>)}
                </details><section className={styles.card}><h3>{text("工作文件")}<span className={styles.badge}>{text("服务端工作区")}</span></h3><p className={styles.muted}>当前为独立文字文件，不代表已连接手机目录。单文件32KiB；同名文件按版本核对。</p>
                <div className={styles.row}>{kind === 'private' && ['all','diary','notes','projects'].map(item => <button type="button" key={item} disabled={busy} onClick={() => setFolder(item)}>{({all:'全部',diary:'日记',notes:'笔记',projects:'项目'} as Record<string,string>)[item]}</button>)}</div>
                {kind === 'private' && <div className={styles.row}><button disabled={busy} onClick={() => { const date = new Date(); const today = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-'); setFilePath('diary/'+today+'.md'); setFileText(''); setFileVersion(0); }}>新日记</button><button disabled={busy} onClick={() => { setFilePath('notes/untitled.md'); setFileText(''); setFileVersion(0); }}>新笔记</button><button disabled={busy} onClick={() => { setFilePath('projects/untitled.md'); setFileText(''); setFileVersion(0); }}>新项目记录</button></div>}
                <div className={styles.files}>{workspace.files?.filter(file => folder === 'all' || file.path.startsWith(folder+'/')).map(file => <button type="button" key={file.path} disabled={busy} onClick={() => void action(async signal => { const result = await call('read_file', { workspaceId: workspace.id, path: file.path }, signal); if (result.result) { setFilePath(file.path); setFileText(result.result.content); setFileBaseline(result.result.content); setFileVersion(result.result.version); setFileHistory(null); setVersionPreview(null); } })}>{file.path}<small>v{file.version} · {file.bytes} B</small></button>)}</div>
                <label>文件相对路径<input aria-label={text("工作文件路径")} value={filePath} disabled={busy} onChange={e => { setFilePath(e.target.value); setFileVersion(0); setFileHistory(null); setVersionPreview(null); }} /></label><textarea aria-label={text("工作文件正文")} value={fileText} disabled={busy || workspace.archived} onChange={e => setFileText(e.target.value)} rows={6} />
                <div className={styles.row}><span className={styles.muted}>当前编辑版本 {fileVersion}</span><button type="button" disabled={busy || !filePath.trim() || workspace.archived} onClick={() => void action(async signal => { const result = await call('write_file', { workspaceId: workspace.id, path: filePath, content: fileText, baseVersion: fileVersion }, signal); apply(result); if (result.result) { setFileVersion(result.result.version); setFileBaseline(result.result.content); setFileHistory(null); setVersionPreview(null); } setNote(text("工作文件已保存。")); })}>{text("保存工作文件")}</button></div>
            </section><section className={styles.card}><h3>文件版本</h3><p className={styles.muted}>先查看旧版，再恢复成一个新版本。不会倒退版本号或覆盖另一设备的新改动。历史从本功能启用后记录，安装前的旧内容不能重建。</p>
                <button type="button" disabled={busy || fileVersion < 1} onClick={() => void action(async signal => { const result = await call('file_history', { workspaceId: workspace.id, path: filePath }, signal); setFileHistory(result.fileHistory || null); setVersionPreview(null); })}>查看当前文件历史</button>
                {fileHistory?.path === filePath && <div className={styles.files}>{fileHistory.versions.map(item => <button type="button" key={item.version} disabled={busy} onClick={() => void action(async signal => { const result = await call('read_file_version', { workspaceId: workspace.id, path: filePath, version: item.version }, signal); if (result.result) setVersionPreview(result.result); })}>查看版本 v{item.version}<small>{item.bytes} B · {item.source === 'ai' ? 'AI写入' : item.source === 'restore' ? '恢复' : item.source === 'manual' ? '人工保存' : '已有版本'}{item.restoredFrom ? ` · 来自v${item.restoredFrom}` : ''}</small></button>)}</div>}
                {versionPreview?.path === filePath && <><p className={styles.muted}>旧版预览 v{versionPreview.version} · 当前编辑器 v{fileVersion}</p><pre className={styles.versionPreview}>{versionPreview.content || '（空文件）'}</pre><button type="button" disabled={busy || workspace.archived || fileText !== fileBaseline || versionPreview.version === fileVersion} onClick={restoreVersion}>恢复为新版本</button>{fileText !== fileBaseline && <p className={styles.muted}>请先保存当前编辑，避免丢失尚未保存的内容。</p>}</>}
            </section></div>
                <div style={{display: drawer === 'context' ? undefined : 'none'}}>
                    {config && <label className={ui.field}>模型窗口 Token<input aria-label={text("工作模型上下文窗口")} type="number" min={1024} max={2000000} value={config.contextWindowTokens ?? ''} disabled={busy} placeholder="实际模型窗口" onChange={event => { const value = Number(event.target.value), fresh = loadApiConfigs().map(row => row.id === config.id ? { ...row, contextWindowTokens: Number.isSafeInteger(value) && value >=1024 && value <=2000000 ? value : undefined } : row); saveApiConfigs(fresh); setConfigs(fresh); }} /></label>}
                    <section className={styles.card}><h3>续聊摘要</h3><p className={styles.muted}>明确压缩才调用一次所选模型；每次最多整理十组较早对话，最近四组保持原文。历史仍可查看导出，保存容量不变；文件正文不会自动装入摘要。</p>
                <button type="button" disabled={busy || !config || workspace.archived || !!workspace.activeRun || summaryDirty || (workspace.messages?.filter(m => m.role === 'user').length || 0) <= 4} onClick={() => compress(false)}>压缩较早对话并启用</button>{summaryDirty && <p className={styles.muted}>请先保存人工摘要，再压缩后续对话。</p>}
                {workspace.context?.summary && <><label className={styles.check}><input type="checkbox" aria-label="后续使用本区摘要" disabled={busy || workspace.archived || !!workspace.activeRun} checked={workspace.context.enabled} onChange={event => void action(async signal => apply(await call('context_config', { workspaceId: workspace.id, version: workspace.version, enabled: event.target.checked }, signal)))} />后续使用本区摘要</label><p className={styles.muted}>v{workspace.context.summary.version} · 已覆盖{workspace.context.summary.throughCount}条原消息 · {workspace.context.summary.source === 'human' ? '人工编辑' : '模型压缩'}。停用会恢复发送全部原文，仍受模型窗口限制。</p><textarea aria-label="本区续聊摘要" value={summaryDraft} disabled={busy || workspace.archived || !!workspace.activeRun} onChange={event => setSummaryDraft(event.target.value)} rows={5} /><button type="button" disabled={busy || workspace.archived || !!workspace.activeRun || !summaryDraft.trim() || summaryDraft === workspace.context.summary.text} onClick={() => void action(async signal => { apply(await call('context_save', { workspaceId: workspace.id, version: workspace.version, baseSummaryVersion: workspace.context!.summary!.version, text: summaryDraft }, signal)); setNote('人工摘要已保存；旧版本不能覆盖这次修改。'); })}>保存人工摘要</button></>}
            </section>
                    <div className={ui.toolActions}><button type="button" disabled={busy} onClick={exportWork}>导出本会话</button><button type="button" disabled={busy || !!workspace.activeRun} onClick={() => void action(async signal => { apply(await call('archive',{workspaceId:workspace.id,version:workspace.version,archived:!workspace.archived},signal));setShowArchived(true); })}>{workspace.archived ? '恢复会话' : '归档会话'}</button></div>
                    <p className={ui.quiet}>普通回复直接使用当前模型；实际工具往返按请求记录用量。原文保留，手动压缩才另发摘要请求。手机权限由你在本机决定。</p>
                </div>
            </aside>}
        </div>
    </main>;
}
