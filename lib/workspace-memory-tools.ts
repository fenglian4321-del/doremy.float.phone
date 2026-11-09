import type { EnabledTool } from './tool-storage';
const GROUP = '共享记忆（VPS）', SOURCE = 'workspace-shared-memory';
const params = (properties: Record<string, unknown>, required: string[]) => JSON.stringify({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', description: '刚读取的正式记忆ID' }, revision = { type: 'string', description: '对应读取结果的revision，不能猜测或省略' };
const specs = [
    { name: '列出共享记忆', description: '与记忆星图相同的VPS正式库。返回一页条目预览和版本；state=active/archived/deleted。', parameterSchema: params({ state: { type: 'string', enum: ['active', 'archived', 'deleted'] }, cursor: { type: 'string' } }, ['state']) },
    { name: '搜索共享记忆', description: '在正式共享库按关键词搜索，不改用本机记忆。', parameterSchema: params({ query: { type: 'string', maxLength: 500 } }, ['query']) },
    { name: '读取共享记忆', description: '读取指定正式条目正文和revision，修改前必须先读取。', parameterSchema: params({ id }, ['id']) },
    { name: '保存共享记忆', description: '新增或按原revision修改共享记忆。写前必须由用户在会话确认完整内容。修改需id/revision；新增不要填id/revision。保留来源、版本与撤销。', parameterSchema: params({ content: { type: 'string', maxLength: 32000 }, id, revision }, ['content']) },
    { name: '整理共享记忆', description: '按原revision归档、移入可恢复回收站或恢复；不会永久删除。必须用户确认。', parameterSchema: params({ id, revision, operation: { type: 'string', enum: ['archive', 'delete', 'restore'] } }, ['id', 'revision', 'operation']) },
    { name: '查看共享记忆历史', description: '返回版本操作和修改前后内容，撤销前先读取。', parameterSchema: params({ id }, ['id']) },
    { name: '撤销共享记忆修改', description: '撤销刚读取的历史操作，仍须原库版本校验和用户确认，冲突不覆盖。', parameterSchema: params({ operationId: { type: 'string' } }, ['operationId']) },
];
export const workspaceMemoryGroup: EnabledTool = { name: GROUP, description: '与独立记忆星图共享同一VPS正式库：按需读取、纠错、归档、回收与撤销。需要本人连接；写入逐次确认。', source: 'internal', sourceId: SOURCE, parameterSchema: '{}', usageGuide: specs.map(row => `${row.name}：${row.description}\n参数：${row.parameterSchema}`).join('\n\n') };
export function workspaceMemoryTool(name: string): EnabledTool | undefined { const spec = specs.find(row => row.name === name); return spec ? { ...spec, source: 'internal', sourceId: SOURCE } : undefined; }
export const isWorkspaceMemoryTool = (tool: EnabledTool) => tool.sourceId === SOURCE;
export const isWorkspaceMemoryRead = (name: string) => ['列出共享记忆', '搜索共享记忆', '读取共享记忆', '查看共享记忆历史'].includes(name);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function exact(input: Record<string, unknown>, allowed: string[], required: string[]) { if (Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) throw new Error('共享记忆参数不符合声明。'); }
function text(value: unknown, max = 160) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('共享记忆参数无效。'); return value; }
async function request(action: string, input: Record<string, unknown> | undefined, query: Record<string, string>, signal: AbortSignal) {
    const response = await fetch('/api/shared-memory?' + new URLSearchParams({ action, ...query }), { method: input ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: input ? { 'Content-Type': 'application/json' } : {}, ...(input ? { body: JSON.stringify({ action, ...input }) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('共享记忆操作未确认，请在记忆星图核对本人连接、原版本与回执；未切换本机库。'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('共享记忆返回为空。');
    const decoder = new TextDecoder('utf-8', { fatal: true }); let raw = '', size = 0;
    try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) throw new Error('共享记忆返回超过容量。'); raw += decoder.decode(part.value, { stream: true }); } raw += decoder.decode(); const data: unknown = JSON.parse(raw); if (!record(data) || data.ok !== true) throw new Error('共享记忆返回未确认。'); return data; }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export class WorkspaceMemoryTools {
    private revisions = new Map<string, string>(); private history = new Set<string>();
    private remember(row: Record<string, unknown>) { if (typeof row.id === 'string' && typeof row.revision === 'string') { if (this.revisions.size >= 128) this.revisions.delete(this.revisions.keys().next().value!); this.revisions.set(row.id, row.revision); } }
    private checked(input: Record<string, unknown>) { const target = text(input.id), version = text(input.revision); if (this.revisions.get(target) !== version) throw new Error('先读取该记忆的当前版本，再提出本次修改。'); return { targetId: target, baseRevision: version }; }
    async execute(name: string, input: Record<string, unknown>, context: { mode: 'work' | 'private'; workspaceId: string; runId: string; callId: string }, signal: AbortSignal): Promise<unknown> {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(context))); const clientKey = 'workspace_' + [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (name === '列出共享记忆') {
            exact(input, ['state', 'cursor'], ['state']); if (!['active', 'archived', 'deleted'].includes(String(input.state))) throw new Error('请选择正式记忆状态。');
            const data = await request('review_catalog', undefined, { state: String(input.state), ...(input.cursor ? { cursor: text(input.cursor) } : {}) }, signal);
            if (!Array.isArray(data.entries)) throw new Error('共享记忆目录无效。');
            return { entries: data.entries.slice(0, 100).map(row => { if (!record(row)) throw new Error('共享记忆条目无效。'); this.remember(row); return { id: row.id, revision: row.revision, state: row.state, preview: typeof row.content === 'string' ? row.content.slice(0, 180) : '' }; }), nextCursor: data.nextCursor };
        }
        if (name === '搜索共享记忆') { exact(input, ['query'], ['query']); const data = await request('search', undefined, { q: text(input.query, 500) }, signal); return { entries: data.entries }; }
        if (name === '读取共享记忆') { exact(input, ['id'], ['id']); const data = await request('review_detail', undefined, { id: text(input.id) }, signal); if (!record(data.entry)) throw new Error('共享记忆条目无效。'); this.remember(data.entry); return data.entry; }
        if (name === '保存共享记忆') {
            exact(input, ['content', 'id', 'revision'], ['content']); const content = text(input.content, 32000), edit = !!input.id; const target = edit ? this.checked(input) : {};
            if (!edit && input.revision) throw new Error('新增记忆不接收旧版本。');
            const data = await request('review_save', { clientKey, kind: edit ? 'edit' : 'create', content, ...target, source: { client: 'float-workspace', proposedBy: 'selected_model', confirmation: 'human_per_action', workspaceId: context.workspaceId, runId: context.runId, mode: context.mode } }, {}, signal);
            const candidate = record(data.candidate) ? data.candidate : {}; if (candidate.state !== 'approved') throw new Error('共享记忆写入尚未确认，请在星图核对原候选。');
            if (edit) this.revisions.delete(String(input.id)); return { saved: true, targetId: candidate.targetId, operationId: candidate.id, clientKey, location: 'canonical_vps_memory' };
        }
        if (name === '整理共享记忆') { exact(input, ['id', 'revision', 'operation'], ['id', 'revision', 'operation']); if (!['archive', 'delete', 'restore'].includes(String(input.operation))) throw new Error('不支持永久删除记忆。'); const data = await request('review_manage', { ...this.checked(input), operation: input.operation, clientKey }, {}, signal); if (!record(data.management) || data.management.state !== 'completed') throw new Error('共享记忆管理回执未确认。'); this.revisions.delete(String(input.id)); return data.management; }
        if (name === '查看共享记忆历史') { exact(input, ['id'], ['id']); const data = await request('review_history', undefined, { id: text(input.id) }, signal); if (!Array.isArray(data.history)) throw new Error('共享记忆历史无效。'); for (const row of data.history) if (record(row) && typeof row.id === 'string') this.history.add(row.id); return { history: data.history }; }
        if (name === '撤销共享记忆修改') { exact(input, ['operationId'], ['operationId']); const operationId = text(input.operationId); if (!this.history.has(operationId)) throw new Error('撤销前请先读取原记忆修改历史。'); const data = await request('review_undo_save', { id: operationId, clientKey }, {}, signal); if (!record(data.candidate) || data.candidate.state !== 'approved') throw new Error('撤销回执未确认，未覆盖当前版本。'); this.revisions.clear(); return { undone: true, operationId, clientKey }; }
        throw new Error('共享记忆动作未声明。');
    }
}
