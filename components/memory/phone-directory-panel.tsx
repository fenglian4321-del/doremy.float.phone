"use client";
import { useEffect, useRef, useState } from 'react';
import { abandonPhoneFileWait, phoneFileAvailability, phoneFileCall, phoneFileReceipt, recoverPhoneFileCall, type PhoneFile, type PhoneFileResult, type PhoneFileScope, type PhoneGrant } from '@/lib/scoped-phone-files';
import styles from './workspace.module.css';
import { enablePhoneTools, disablePhoneTools, type PhoneToolTrace } from '@/lib/phone-file-tools';

export function PhoneDirectoryPanel({ kind, workspaceId, disabled = false, trace = [] }: { kind: 'work' | 'private'; workspaceId: string; disabled?: boolean; trace?: PhoneToolTrace[] }) {
    const scope: PhoneFileScope = { mode: kind, workspaceId };
    const [availability, setAvailability] = useState({ available: false, message: '正在检查此页面的本机桥。' });
    const [grants, setGrants] = useState<PhoneGrant[]>([]), [selected, setSelected] = useState('');
    const [directory, setDirectory] = useState(''), [files, setFiles] = useState<PhoneFile[]>([]);
    const [readPath, setReadPath] = useState(''), [content, setContent] = useState(''), [savePath, setSavePath] = useState('new-note.md');
    const [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [offline, setOffline] = useState(false);
    const active = useRef<AbortController | null>(null);
    const [aiEnabled, setAiEnabled] = useState(false), [allowCreate, setAllowCreate] = useState(false), [enabling, setEnabling] = useState(false);
    useEffect(() => {
        const inspect = () => { setAvailability(phoneFileAvailability()); setOffline(navigator.onLine === false); };
        inspect(); setPending(!!phoneFileReceipt({ mode: kind, workspaceId }));
        window.addEventListener('floatshell-bridge-ready', inspect); window.addEventListener('online', inspect); window.addEventListener('offline', inspect);
        return () => { disablePhoneTools({ mode: kind, workspaceId }); active.current?.abort(); window.removeEventListener('floatshell-bridge-ready', inspect); window.removeEventListener('online', inspect); window.removeEventListener('offline', inspect); };
    }, [kind, workspaceId]);
    const apply = (result: PhoneFileResult) => {
        if (result.grants) { setGrants(result.grants); setSelected(value => result.grants!.some(grant => grant.id === value) ? value : ''); }
        if (result.grant) { setGrants(old => [...old.filter(grant => grant.id !== result.grant!.id), result.grant!]); setSelected(result.grant.id); setNotice('此目录已绑定当前空间；尚未读取目录内容。'); }
        if (result.files) { setFiles(result.files); setDirectory(result.path || ''); setNotice('目录清单由此手机回报，未上传VPS。'); }
        if (typeof result.content === 'string') { setReadPath(result.path || ''); setContent(result.content); setNotice('已读取此手机的文字；下方可另存为新文件。'); }
        if (result.created) setNotice(`本机已核对新文件：${result.path}。原文件没有被覆盖。`);
        if (result.revoked) { setGrants(old => old.filter(grant => grant.id !== selected)); setSelected(''); setFiles([]); setContent(''); setReadPath(''); setNotice('当前目录授权记录已撤销；手机文件没有被删除。'); }
    };
    const run = async (fn: (signal: AbortSignal) => Promise<PhoneFileResult>) => {
        const controller = new AbortController(); active.current = controller; setBusy(true); setError(''); setNotice('');
        try { const result = await fn(controller.signal); if (!controller.signal.aborted) apply(result); }
        catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '手机操作结果未确认。'); else setNotice('已停止等待，请核对同一手机回执。'); }
        finally { if (active.current === controller) { active.current = null; setBusy(false); setPending(!!phoneFileReceipt(scope)); } }
    };
    const toggleAi = async (enabled: boolean) => {
        if (!enabled) { disablePhoneTools(scope); setAiEnabled(false); setAllowCreate(false); setNotice('已停用AI手机工具；已提交的新建不能撤回，请核对目录及回执。'); return; }
        setEnabling(true); setError('');
        try {
            const session = await enablePhoneTools(scope, selected, allowCreate);
            setAiEnabled(true);
            session.signal.addEventListener('abort', () => { setAiEnabled(false); setAllowCreate(false); setPending(!!phoneFileReceipt(scope)); setNotice('本次AI手机授权已结束；再次使用需重新明确启用，已提交操作请核对回执。'); }, { once: true });
            setNotice('下一次新消息只使用此手机目录工具；本轮结束后自动停用。');
        } catch { setAiEnabled(false); setError('未启用AI手机目录；请明确选择有效授权并核对待处理回执。'); }
        finally { setEnabling(false); }
    };
    const selectedGrant = grants.find(grant => grant.id === selected);
    const locked = disabled || busy || !availability.available || pending || aiEnabled || enabling;
    return <section className={styles.card} aria-label="手机授权目录"><details><summary>手机授权目录 · 仅此设备</summary>
        <p className={styles.muted}>{availability.message}</p>
        <p className={styles.muted}>{offline ? '网页当前离线；本机目录可尝试访问，云盘文件能否打开取决于系统提供器。' : '由系统文件提供器执行；网络正常也不代表云盘文件一定可用。'}</p>
        <p className={styles.muted}>目录仅绑定当前{kind === 'private' ? '私人空间' : '工作区'}。默认手动查看、另存；不会自动交给AI或写入生活记忆。</p>
        <div className={styles.row}><button type="button" disabled={locked} onClick={() => void run(signal => phoneFileCall(scope, 'picker', {}, signal))}>选择并授权手机目录</button><button type="button" disabled={locked} onClick={() => void run(signal => phoneFileCall(scope, 'grants', {}, signal))}>查看本区目录授权</button></div>
        {pending && <div className={styles.pending}><p>上次手机操作回执尚待核对；不会自动重复创建文件。核对创建只读取原目标并比较摘要。</p><button type="button" disabled={disabled || busy || !availability.available} onClick={() => void run(signal => recoverPhoneFileCall(scope, signal))}>核对手机操作回执</button><p className={styles.muted}>清除本页等待标记不会删除文件，也不能撤回已提交的创建；请自行核对手机目录。</p><button type="button" disabled={disabled || busy} onClick={() => { abandonPhoneFileWait(scope); setPending(false); setNotice('仅清除了本页等待标记；没有撤销手机操作或删除文件。'); }}>已了解，清除等待标记</button></div>}
        {grants.length > 0 && <><label>当前手机目录<select aria-label="当前手机目录" value={selected} disabled={locked} onChange={event => { setSelected(event.target.value); setDirectory(''); setFiles([]); setReadPath(''); setContent(''); }}><option value="">明确选择一个本区目录</option>{grants.map(grant => <option key={grant.id} value={grant.id}>{grant.label} · {grant.readable ? grant.writable ? '可读 / 可另存' : '只读' : '权限失效'}</option>)}</select></label>
            <label>目录内相对路径<input aria-label="手机子目录路径" value={directory} disabled={locked} onChange={event => setDirectory(event.target.value)} placeholder="留空为所选目录" /></label>
            <div className={styles.row}><button type="button" disabled={locked || !selectedGrant?.readable} onClick={() => void run(signal => phoneFileCall(scope, 'list', { grantId: selected, path: directory }, signal))}>列出手机目录</button><button type="button" disabled={locked || !selected} onClick={() => void run(signal => phoneFileCall(scope, 'revoke', { grantId: selected }, signal))}>撤销此目录授权</button></div>
            <div className={styles.files}>{files.map(file => <button type="button" key={file.name} disabled={locked} onClick={() => { const path = [directory, file.name].filter(Boolean).join('/'); if (file.directory) { setDirectory(path); setFiles([]); } else void run(signal => phoneFileCall(scope, 'read', { grantId: selected, path }, signal)); }}>{file.name}<small>{file.directory ? '目录 · 点击进入路径' : `${file.bytes === null ? '大小未知' : file.bytes + ' B'} · 点击读取文字`}</small></button>)}</div>
            <p className={styles.muted}>{readPath ? `读取自：${readPath}` : '尚未读取手机文件。'} 只支持UTF-8文字，每文件32KiB，不覆盖或删除已有文件。</p>
            <textarea aria-label="手机文字草稿" value={content} disabled={locked} onChange={event => setContent(event.target.value)} rows={5} placeholder="只在此页面编辑；另存前不会改变手机文件" />
            <label>另存新文件的相对路径<input aria-label="手机新文件路径" value={savePath} disabled={locked} onChange={event => setSavePath(event.target.value)} /></label>
            <button type="button" disabled={locked || !selectedGrant?.writable || !savePath.trim()} onClick={() => void run(signal => phoneFileCall(scope, 'create', { grantId: selected, path: savePath, content }, signal))}>另存为手机新文件</button>
        </>}
        {busy && <button type="button" onClick={() => active.current?.abort()}>停止等待手机</button>}
        <fieldset className={styles.phoneAi}><legend>AI使用此手机目录 · 实验功能</legend>
            <p className={styles.muted}>默认关闭，原生APK编译与真机仍待验证。先由你选择本区授权目录，AI不能打开授权窗口。开启后，本次新消息的文件工具只操作此手机，VPS文件工具暂停；读取及新建正文会发送给你所选的聊天API，最终回复仍保存为本区对话。</p>
            <label className={styles.check}><input type="checkbox" aria-label="允许AI另存手机新文件" checked={allowCreate} disabled={locked || !selectedGrant?.writable} onChange={event => setAllowCreate(event.target.checked)} />允许AI另存新文件（仍不覆盖、删除或移动原件）</label>
            <label className={styles.check}><input type="checkbox" aria-label="本次新消息使用AI手机目录" checked={aiEnabled} disabled={!aiEnabled && (locked || !selectedGrant?.readable)} onChange={event => void toggleAi(event.target.checked)} />本次新消息使用AI手机目录</label>
            {aiEnabled && <button type="button" onClick={() => void toggleAi(false)}>停用AI手机工具并停止本轮</button>}
            <p className={styles.muted}>先列目录再读取或另存；先核对同名文件。工具正文只保留在本页本轮上下文，不单独写入操作日志。中断或换页后先核对手机回执，再结束原任务、明确发起新消息，不自动重做新建。目录撤权或停用后停止后续动作；已发送的模型上下文和已提交的新建无法撤回。</p>
            {trace.length > 0 && <ul aria-label="AI手机操作回执">{trace.map((item, index) => <li key={index}>{({ list: '列目录', read: '读文字', create: '另存新文件' })[item.operation]} · 此手机 · {item.ok ? '完成回执已核对' : '未执行'} · {item.receiptId || item.code || '无完成回执'}</li>)}</ul>}
        </fieldset>
        {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    </details></section>;
}
