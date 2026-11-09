'use client';
import { useCallback, useEffect, useState } from 'react';
import { acknowledgeWorkspaceActions, workspaceActionReceipts, workspaceFloatToolCatalog, workspaceFloatTargets } from '@/lib/workspace-assistant-session';
import type { SpaceKind } from '@/lib/workspace-client';
import styles from './workbench.module.css';
export function FloatToolPanel({ kind, workspaceId, disabled, enabled, onEnable, selected, onSelect, characterId, onCharacter }: { kind: SpaceKind; workspaceId: string; disabled: boolean; enabled: boolean; onEnable: (value: boolean) => void; selected: string[]; onSelect: (value: string[]) => void; characterId: string; onCharacter: (value: string) => void }) {
    const [catalog, setCatalog] = useState(workspaceFloatToolCatalog), [query, setQuery] = useState(''), [note, setNote] = useState(''), [unresolved, setUnresolved] = useState(0);
    const [targets] = useState(workspaceFloatTargets);
    const refresh = useCallback(() => { setCatalog(workspaceFloatToolCatalog()); try { setUnresolved(workspaceActionReceipts({ mode: kind, workspaceId }).filter(row => ['reserved', 'uncertain'].includes(row.state)).length); } catch { setNote('原动作记录无法读取，请先人工核对Float实际结果。'); } }, [kind, workspaceId]);
    useEffect(() => { refresh(); }, [refresh, disabled]); // Refresh is an explicit local metadata read, not a model request.
    return <section className={styles.toolGroup} aria-label="Float内部工具">
        <h3>Float 能力</h3><p>沿用工具箱中已启用的内置、REST、组合与自定义 App 工具。没有打开的能力不会自动代开；按需读取的数据会交给当前模型。工具以实际可用范围为准。</p>
        <div className={styles.toolActions}><button type="button" disabled={disabled} onClick={refresh}>刷新可用工具</button><button type="button" disabled={disabled} onClick={() => { onSelect([]); onEnable(false); }}>清空本轮选择</button></div>
        <input aria-label="筛选Float工具" value={query} onChange={event => setQuery(event.target.value)} placeholder="找工具或能力…" />
        <div className={styles.toolList}>{catalog.filter(tool => (tool.name + tool.description).toLowerCase().includes(query.toLowerCase())).map(tool => <label key={tool.source + ':' + tool.sourceId + ':' + tool.name}><input type="checkbox" disabled={disabled} checked={selected.includes(tool.name)} onChange={event => { onEnable(false); onSelect(event.target.checked ? [...new Set([...selected, tool.name])].slice(0, 64) : selected.filter(name => name !== tool.name)); }} /><span><strong>{tool.name}</strong><small>{tool.description}</small></span></label>)}{!catalog.length && <p>暂无已启用工具。可先在 Float 工具箱启用需要的能力，再回来刷新。</p>}</div>
        <label className={styles.field}>操作对象（可选生活私聊）<select aria-label="Float工具目标私聊" value={characterId} disabled={disabled} onChange={event => { onEnable(false); onCharacter(event.target.value); }}><option value="">不绑定生活私聊</option>{targets.map(row => <option value={row.id} key={row.id}>{row.label}</option>)}</select></label>
        <label className={styles.check}><input type="checkbox" checked={enabled} disabled={disabled || (!enabled && (!selected.length || unresolved > 0))} onChange={event => onEnable(event.target.checked)} /><span>本次新消息允许使用已选 {selected.length} 项 Float 能力</span></label>
        <p>本地只读动作按授权执行；写入、外发及未知动作在会话中逐次核对。这里的授权在本轮结束后关闭，不自动注入生活记忆。</p>
        {unresolved > 0 && <p role="status">有 {unresolved} 条原动作结果未确认，先检查 Float 和真机，再开始新任务。</p>}
        <button type="button" disabled={disabled} onClick={() => { const scope = { mode: kind, workspaceId }; void acknowledgeWorkspaceActions(scope).then(() => { refresh(); setNote('原标记已人工核对；没有重做、撤销或隐藏实际动作。'); }).catch(() => setNote('原回执未确认。')); }}>我已核对实际结果，标记原回执已检查</button>
        {note && <p role="status">{note}</p>}
    </section>;
}
