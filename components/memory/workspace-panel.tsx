"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadApiConfigs, saveApiConfigs } from '@/lib/settings-storage';
import type { ApiConfig } from '@/lib/settings-types';
import { connectWorkspaceOwner, endWorkspaceRun, runWorkspaceChat, compressWorkspaceContext, spaceCall, workspaceReceipt, type Workspace, type WorkspaceResult, type WorkspaceTrace, type SpaceKind, type AttachmentRef, type SpaceFileHistory } from '@/lib/workspace-client';
import { getUsageLedger } from '@/lib/usage-ledger';
import styles from './workspace.module.css';
import { readSpaceTextAttachment } from '@/lib/space-attachments';
import { PhoneDirectoryPanel } from './phone-directory-panel';
import type { PhoneToolTrace } from '@/lib/phone-file-tools';

export function WorkspacePanel({ onBack, kind = 'work' }: { onBack: () => void; kind?: SpaceKind }) {
    const text = useCallback((value: string) => kind === 'private' ? value.replaceAll('WORK · 独立工作区', 'PRIVATE · AI私人空间').replaceAll('独立工作区', 'AI私人空间').replaceAll('工作助手', '空间里的AI').replaceAll('工作区', '私人空间').replaceAll('工作', '私人') : value, [kind]);
    const call = useCallback((operation: string, payload: Record<string, unknown> = {}, signal?: AbortSignal) => spaceCall(kind, operation, payload, signal), [kind]);
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
        void refreshList(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : text("工作区尚未就绪。")); });
        return () => { controller.abort(); active.current?.abort(); };
    }, [refreshList, text]);
    useEffect(() => {
        setWorkspace(null); setFileText(''); setFileVersion(0); setFilePath('notes/plan.md'); setDraft(''); setNote(''); setTrace([]); setPhoneTrace([]); setSelectedAttachments([]); setFolder('all');
        if (!selected) return;
        const saved = workspaceReceipt(selected, kind);
        setTaskKind(saved?.kind || 'chat'); setFileHistory(null); setVersionPreview(null); setFileBaseline(''); restoreKeys.current.clear();
        if (saved?.configId && loadApiConfigs().some(c => c.id === saved.configId)) setConfigId(saved.configId);
        const controller = new AbortController();
        void call('detail', { workspaceId: selected }, controller.signal).then(result => { if (!controller.signal.aborted) { setWorkspace(result.workspace); setTaskKind(result.run?.kind || saved?.kind || 'chat'); setTrace(result.run?.trace || []); setCalls(getUsageLedger().filter(row => row.source === kind && row.scopeId === selected).length); } }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : text("工作区读取失败。")); });
        return () => controller.abort();
    }, [selected, kind, call, text]);
    useEffect(() => { setSummaryDraft(workspace?.context?.summary?.text || ''); }, [workspace?.id, workspace?.context?.summary?.version, workspace?.context?.summary?.text]);
    const apply = (result: WorkspaceResult) => {
        setWorkspace(result.workspace);
        setSelectedAttachments(old => old.filter(ref => result.workspace.files?.some(file => file.path === ref.path && file.version === ref.version)));
        if (result.run) { setTrace(result.run.trace || []); setTaskKind(result.run.kind || 'chat'); }
        setSpaces(old => old.map(w => w.id === result.workspace.id ? result.workspace : w));
        setCalls(getUsageLedger().filter(row => row.source === kind && row.scopeId === result.workspace.id).length);
    };
    const action = async (fn: (signal: AbortSignal) => Promise<void>) => {
        const controller = new AbortController(); active.current = controller;
        setBusy(true); setError('');
        try { await fn(controller.signal); }
        catch (cause) { if (controller.signal.aborted) setNote(text("已停止。已完成操作保留；手机工具先核对回执，其他工作任务可恢复。")); else setError(cause instanceof Error ? cause.message : text("工作操作未确认。")); }
        finally { if (active.current === controller) { setBusy(false); active.current = null; } }
    };
    const chat = (resume: boolean) => void action(async signal => {
        if (!workspace || !config) throw new Error(text("请先选择工作区和聊天API。"));
        if (!resume) setPhoneTrace([]);
        await runWorkspaceChat(workspace, config, resume ? null : draft, signal, (result, message) => {
            if (!signal.aborted) { apply(result); if (!resume) { setDraft(''); setSelectedAttachments([]); } if (message) setNote(message); }
        }, kind, selectedAttachments, item => { if (!signal.aborted) setPhoneTrace(old => [...old, item]); });
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
    return <div className={`${styles.page} ${kind === 'private' ? styles.privatePage : ''}`}>
        <header className={styles.header}><button type="button" onClick={() => { active.current?.abort(); onBack(); }}>‹ 返回生活区</button><span className={styles.badge}>{text("WORK · 独立工作区")}</span></header>
        <section className={styles.hero}><p className={styles.eyebrow}>{kind === 'private' ? 'A ROOM FOR THOUGHTS' : 'A QUIET PLACE TO BUILD'}</p><h2>{kind === 'private' ? '给自己的几页留白。' : '把正在做的事，留在这里。'}</h2><p>{text("工作对话与文件单独保存；不自动读取或写入生活记忆。")}</p></section>
        <section className={styles.card}>
            <div className={styles.row}><label className={styles.grow}>{text("当前工作区")}<select aria-label={text("当前工作区")} value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}><option value="">选择一个项目</option>{spaces.filter(w => showArchived || !w.archived).map(w => <option key={w.id} value={w.id}>{w.title}{w.archived ? ' · 已归档' : ''}</option>)}</select></label><button type="button" disabled={busy} onClick={() => void action(refreshList)}>刷新</button></div>
            <label className={styles.check}><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />显示归档项目</label>
            <div className={styles.row}><input aria-label={text("新工作区名称")} className={styles.grow} value={title} maxLength={80} placeholder="给新项目起个名字" disabled={busy} onChange={e => { createKey.current = ''; setTitle(e.target.value); }} /><button type="button" disabled={busy || !title.trim()} onClick={() => void action(async signal => { createKey.current ||= crypto.randomUUID(); const result = await call('create', { title: title.trim(), clientKey: createKey.current }, signal); createKey.current = ''; setTitle(''); await refreshList(signal); setSelected(result.workspace.id); apply(result); })}>新建</button></div>
            <details><summary>本人会话</summary><p>复用私人共享服务的本人验证，仅用于身份认证。此操作不会切换生活记忆来源或读取生活事实。</p><div className={styles.row}><input className={styles.grow} aria-label={text("工作区本人访问口令")} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="本人访问口令" /><button type="button" disabled={busy || !token.trim()} onClick={() => void action(async signal => { await connectWorkspaceOwner(token); setToken(''); setError(''); await refreshList(signal); })}>验证</button></div></details>
        </section>
        {workspace && <>
            <section className={styles.card}><div className={styles.row}><label className={styles.grow}>当前聊天模型<select aria-label={text("工作聊天API")} value={configId} disabled={busy} onChange={e => setConfigId(e.target.value)}>{configs.map(c => <option key={c.id} value={c.id}>{c.name || c.provider} · {c.defaultModel}</option>)}</select></label></div>
                {config && <label className={styles.row}>模型窗口 token<input aria-label={text("工作模型上下文窗口")} type="number" min={1024} max={2000000} value={config.contextWindowTokens ?? ''} disabled={busy} placeholder="实际模型窗口" onChange={e => { const value = Number(e.target.value); const fresh = loadApiConfigs().map(c => c.id === config.id ? { ...c, contextWindowTokens: Number.isSafeInteger(value) && value >= 1024 && value <= 2000000 ? value : undefined } : c); saveApiConfigs(fresh); setConfigs(fresh); }} /></label>}
                <p className={styles.muted}>{text("沿用所选API；普通回复一次生成，文件工具需把结果交回模型继续。没有自动前置规划或总结；手动压缩另需一次模型请求。当前工作区已记录")}{calls} 次本机模型请求，用量缺失按未知处理。</p>
            </section>
            <section className={styles.card} aria-label={text("独立工作对话")}><div className={styles.row}><h3>{workspace.title}</h3><span className={styles.badge}>{workspace.archived ? '已归档' : text("工作")}</span></div>
                <div className={styles.messages}>{!workspace.messages?.length && <p className={styles.empty}>{kind === 'private' ? '写点日记、笔记或项目想法；这里不会自动读取生活聊天。' : '描述任务，或在下方先准备一份工作文件。'}</p>}{workspace.messages?.map(message => <article key={message.id} className={message.role === 'user' ? styles.user : styles.assistant}><small>{message.role === 'user' ? '你' : text("工作助手")}</small><p>{message.content}</p>{message.attachments?.map(ref => <small key={ref.path}>附件：{ref.path} · v{ref.version} </small>)}</article>)}</div>
                {trace.length > 0 && <details><summary>{text("工作工具回执 ·")}{trace.length}</summary>{trace.map(item => <p className={styles.muted} key={item.id}>{item.ok ? '已完成' : '未执行'} · {item.path || text("工作文件操作")}{item.version ? ` · v${item.version}` : ''}{item.error ? ` · ${item.error}` : ''}</p>)}</details>}
                {workspace.activeRun && <div className={styles.pending}><p>{taskKind === 'compression' ? '有一个未结束的摘要任务。恢复可能请求原模型；旧摘要与原文保留。' : text("有一个未结束的工作任务。恢复可能继续请求原模型，已完成的文件操作不会重复执行。")}</p><div className={styles.row}><button type="button" disabled={busy || !config} onClick={resumeTask}>{taskKind === 'compression' ? '恢复摘要任务' : '恢复同一任务'}</button><button type="button" disabled={busy} onClick={() => void action(async () => { const known = workspaceReceipt(workspace.id, kind); apply(await endWorkspaceRun(workspace.id, !known?.runId, kind)); setNote(text("任务已结束，已发送消息和工作文件保留。")); })}>结束任务</button></div></div>}
                {!workspace.activeRun && workspaceReceipt(workspace.id, kind)?.pending && <button type="button" disabled={busy || !config} onClick={resumeTask}>核对上次发送回执</button>}
                <details><summary>本轮文字附件 · {selectedAttachments.length}/6</summary>
                    <p className={styles.muted}>仅选中的本区文件会随本轮发送，固定所选版本；不会自动读取其他项目或手机目录。</p>
                    <input aria-label="导入文字附件" type="file" accept=".txt,.md,.json,.csv,.log" disabled={busy || workspace.archived} onChange={event => { const input = event.currentTarget, file = input.files?.[0]; if (!file) return; void action(async signal => { try { const item = await readSpaceTextAttachment(file); const result = await call('write_file', { workspaceId: workspace.id, path: item.path, content: item.content, baseVersion: 0 }, signal); apply(result); if (result.result) setSelectedAttachments(old => old.length < 6 ? [...old, { path: result.result!.path, version: result.result!.version }] : old); setNote('文字附件已导入本区；仅勾选项随本轮发送。'); } finally { input.value = ''; } }); }} />
                    {(workspace.files || []).map(file => <label className={styles.check} key={file.path}><input type="checkbox" disabled={busy || workspace.archived} checked={selectedAttachments.some(ref => ref.path === file.path && ref.version === file.version)} onChange={event => { if (event.target.checked && selectedAttachments.length >= 6) { setError('一次最多选择6份文字附件。'); return; } setSelectedAttachments(old => event.target.checked ? [...old.filter(ref => ref.path !== file.path), { path: file.path, version: file.version }] : old.filter(ref => ref.path !== file.path)); }} />{file.path} · v{file.version}</label>)}
                </details>
                <textarea aria-label={text("工作消息")} value={draft} onChange={e => setDraft(e.target.value)} disabled={busy || workspace.archived || !!workspace.activeRun} placeholder="这里的任务不会进入生活记忆…" rows={4} />
                <div className={styles.row}><span className={styles.muted}>{text("原始工作对话保留，不静默截断。")}</span>{busy ? <button type="button" onClick={() => active.current?.abort()}>停止</button> : <button type="button" className={styles.primary} disabled={!draft.trim() || !config || workspace.archived || !!workspace.activeRun} onClick={() => chat(false)}>{text("发送工作消息")}</button>}</div>
            </section>
            <section className={styles.card}><h3>续聊摘要</h3><p className={styles.muted}>明确压缩才调用一次所选模型；每次最多整理十组较早对话，最近四组保持原文。历史仍可查看导出，保存容量不变；文件正文不会自动装入摘要。</p>
                <button type="button" disabled={busy || !config || workspace.archived || !!workspace.activeRun || summaryDirty || (workspace.messages?.filter(m => m.role === 'user').length || 0) <= 4} onClick={() => compress(false)}>压缩较早对话并启用</button>{summaryDirty && <p className={styles.muted}>请先保存人工摘要，再压缩后续对话。</p>}
                {workspace.context?.summary && <><label className={styles.check}><input type="checkbox" aria-label="后续使用本区摘要" disabled={busy || workspace.archived || !!workspace.activeRun} checked={workspace.context.enabled} onChange={event => void action(async signal => apply(await call('context_config', { workspaceId: workspace.id, version: workspace.version, enabled: event.target.checked }, signal)))} />后续使用本区摘要</label><p className={styles.muted}>v{workspace.context.summary.version} · 已覆盖{workspace.context.summary.throughCount}条原消息 · {workspace.context.summary.source === 'human' ? '人工编辑' : '模型压缩'}。停用会恢复发送全部原文，仍受模型窗口限制。</p><textarea aria-label="本区续聊摘要" value={summaryDraft} disabled={busy || workspace.archived || !!workspace.activeRun} onChange={event => setSummaryDraft(event.target.value)} rows={5} /><button type="button" disabled={busy || workspace.archived || !!workspace.activeRun || !summaryDraft.trim() || summaryDraft === workspace.context.summary.text} onClick={() => void action(async signal => { apply(await call('context_save', { workspaceId: workspace.id, version: workspace.version, baseSummaryVersion: workspace.context!.summary!.version, text: summaryDraft }, signal)); setNote('人工摘要已保存；旧版本不能覆盖这次修改。'); })}>保存人工摘要</button></>}
            </section>
            <section className={styles.card}><h3>{text("工作文件")}<span className={styles.badge}>{text("服务端工作区")}</span></h3><p className={styles.muted}>当前为独立文字文件，不代表已连接手机目录。单文件32KiB；同名文件按版本核对。</p>
                <div className={styles.row}>{kind === 'private' && ['all','diary','notes','projects'].map(item => <button type="button" key={item} disabled={busy} onClick={() => setFolder(item)}>{({all:'全部',diary:'日记',notes:'笔记',projects:'项目'} as Record<string,string>)[item]}</button>)}</div>
                {kind === 'private' && <div className={styles.row}><button disabled={busy} onClick={() => { const date = new Date(); const today = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-'); setFilePath('diary/'+today+'.md'); setFileText(''); setFileVersion(0); }}>新日记</button><button disabled={busy} onClick={() => { setFilePath('notes/untitled.md'); setFileText(''); setFileVersion(0); }}>新笔记</button><button disabled={busy} onClick={() => { setFilePath('projects/untitled.md'); setFileText(''); setFileVersion(0); }}>新项目记录</button></div>}
                <div className={styles.files}>{workspace.files?.filter(file => folder === 'all' || file.path.startsWith(folder+'/')).map(file => <button type="button" key={file.path} disabled={busy} onClick={() => void action(async signal => { const result = await call('read_file', { workspaceId: workspace.id, path: file.path }, signal); if (result.result) { setFilePath(file.path); setFileText(result.result.content); setFileBaseline(result.result.content); setFileVersion(result.result.version); setFileHistory(null); setVersionPreview(null); } })}>{file.path}<small>v{file.version} · {file.bytes} B</small></button>)}</div>
                <label>文件相对路径<input aria-label={text("工作文件路径")} value={filePath} disabled={busy} onChange={e => { setFilePath(e.target.value); setFileVersion(0); setFileHistory(null); setVersionPreview(null); }} /></label><textarea aria-label={text("工作文件正文")} value={fileText} disabled={busy || workspace.archived} onChange={e => setFileText(e.target.value)} rows={6} />
                <div className={styles.row}><span className={styles.muted}>当前编辑版本 {fileVersion}</span><button type="button" disabled={busy || !filePath.trim() || workspace.archived} onClick={() => void action(async signal => { const result = await call('write_file', { workspaceId: workspace.id, path: filePath, content: fileText, baseVersion: fileVersion }, signal); apply(result); if (result.result) { setFileVersion(result.result.version); setFileBaseline(result.result.content); setFileHistory(null); setVersionPreview(null); } setNote(text("工作文件已保存。")); })}>{text("保存工作文件")}</button></div>
            </section>
            <section className={styles.card}><h3>文件版本</h3><p className={styles.muted}>先查看旧版，再恢复成一个新版本。不会倒退版本号或覆盖另一设备的新改动。历史从本功能启用后记录，安装前的旧内容不能重建。</p>
                <button type="button" disabled={busy || fileVersion < 1} onClick={() => void action(async signal => { const result = await call('file_history', { workspaceId: workspace.id, path: filePath }, signal); setFileHistory(result.fileHistory || null); setVersionPreview(null); })}>查看当前文件历史</button>
                {fileHistory?.path === filePath && <div className={styles.files}>{fileHistory.versions.map(item => <button type="button" key={item.version} disabled={busy} onClick={() => void action(async signal => { const result = await call('read_file_version', { workspaceId: workspace.id, path: filePath, version: item.version }, signal); if (result.result) setVersionPreview(result.result); })}>查看版本 v{item.version}<small>{item.bytes} B · {item.source === 'ai' ? 'AI写入' : item.source === 'restore' ? '恢复' : item.source === 'manual' ? '人工保存' : '已有版本'}{item.restoredFrom ? ` · 来自v${item.restoredFrom}` : ''}</small></button>)}</div>}
                {versionPreview?.path === filePath && <><p className={styles.muted}>旧版预览 v{versionPreview.version} · 当前编辑器 v{fileVersion}</p><pre className={styles.versionPreview}>{versionPreview.content || '（空文件）'}</pre><button type="button" disabled={busy || workspace.archived || fileText !== fileBaseline || versionPreview.version === fileVersion} onClick={restoreVersion}>恢复为新版本</button>{fileText !== fileBaseline && <p className={styles.muted}>请先保存当前编辑，避免丢失尚未保存的内容。</p>}</>}
            </section>
            <PhoneDirectoryPanel key={kind+":"+workspace.id} kind={kind} workspaceId={workspace.id} disabled={busy || workspace.archived} trace={phoneTrace} />
            <section className={styles.card}><div className={styles.row}><button type="button" disabled={busy} onClick={exportWork}>{text("导出本工作区")}</button><button type="button" disabled={busy || !!workspace.activeRun} onClick={() => void action(async signal => { apply(await call('archive', { workspaceId: workspace.id, version: workspace.version, archived: !workspace.archived }, signal)); setShowArchived(true); })}>{workspace.archived ? text("恢复工作区") : text("归档工作区")}</button></div></section>
        </>}
        {note && <p className={styles.notice} role="status">{note}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    </div>;
}
