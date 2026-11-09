import { kvGet, kvSet, registerDynamicPrefix } from './kv-db';
import { loadMemoryConfig } from './memory-storage';
import { loadChatMessages, type ChatMessage } from './chat-storage';
import type { ApiConfig, PresetConfig } from './settings-types';
import type { LLMMessage } from './llm-prompt-assembler';
import { estimateTokens } from './token-counter';
import { collectConsolidationRecords, consolidationScopeId, consolidationInstruction, extractPrivateDecision, validateMemoryDecision, insertConsolidationLayer, type ConsolidationConfig, type ConsolidationRecord, type ConsolidationScope, type PrivateDecisionEnvelope } from './consolidation-protocol';

const PREFIX = 'float_consolidation_v1_';
registerDynamicPrefix(PREFIX);
const knownWindow = (config: ApiConfig) => Number.isSafeInteger(config.contextWindowTokens) && config.contextWindowTokens! >= 1024 && config.contextWindowTokens! <= 2000000;
type Manifest = { records: Record<string, { digest: string; version: number }>; claim?: string; jobId?: string; error?: string };
export type ConsolidationDiagnostics = { at: number; sourceGroups?: number; excludedMessages?: number; summarySegments?: number; input?: number; reserve?: number; window?: number; tokenKind: 'estimate' };
export async function readConsolidationDiagnostics(scope: ConsolidationScope): Promise<ConsolidationDiagnostics | null> {
    try { return JSON.parse(kvGet(PREFIX + 'diagnostics_' + await consolidationScopeId(scope)) || 'null'); } catch { return null; }
}
async function noteDiagnostics(scope: ConsolidationScope, values: Partial<ConsolidationDiagnostics>) {
    const key = PREFIX + 'diagnostics_' + await consolidationScopeId(scope);
    kvSet(key, JSON.stringify({ ...await readConsolidationDiagnostics(scope), ...values, at: Date.now(), tokenKind: 'estimate' }));
}
export type ConsolidationJob = { id: string; inputDigest: string; inputs: { id: string; digest: string; version: number }[]; previous: { ref: string; text: string }[]; compression: boolean; summaryChars: number; state: string };
export type ConsolidationStatus = {
    protocol: 'float-consolidation/v1'; config: ConsolidationConfig; version: number; count: number; tokens: number;
    pending: number; dirty: number; due: boolean; queued: boolean;
    lastSuccess: { jobId: string; at: number; facts: number; decision: string } | null;
    summary: { text: string; sources: { id: string; digest: string }[] }[];
    active: { id: string; state: string; error: string | null; expires: number; receipts: string[] } | null;
    job?: ConsolidationJob | null;
};
export type ConsolidationProjection = { scope: ConsolidationScope; records: ConsolidationRecord[]; status: ConsolidationStatus; history: ChatMessage[]; summary: string; excluded: number };
export function notifyConsolidation(message?: string) {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('float:consolidation', { detail: message }));
}
export async function consolidationCall(scope: ConsolidationScope, operation: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ConsolidationStatus> {
    const response = await fetch('/api/shared-memory/consolidation', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, operation, ...args }) });
    const body = await response.json();
    if (!response.ok || body.ok !== true || body.protocol !== 'float-consolidation/v1') throw new Error(typeof body.error === 'string' ? body.error : '共享整理服务未就绪，进度未清零。');
    return body as ConsolidationStatus;
}
async function manifest(scope: ConsolidationScope) {
    const key = PREFIX + await consolidationScopeId(scope);
    let value: Manifest = { records: {} };
    try { const raw = kvGet(key); if (raw) value = JSON.parse(raw); } catch { /* Recover metadata from authoritative server. */ }
    return { key, value };
}

/** Only hashes/counts/versions travel on observation. Never upload unsent UI text. */
export async function observeConsolidation(scope: ConsolidationScope, signal?: AbortSignal) {
    const records = await collectConsolidationRecords(scope, await loadChatMessages(scope.sessionId));
    const { key, value } = await manifest(scope);
    const live = new Set(records.map(r => r.id));
    const changes = records.filter(r => value.records[r.id]?.digest !== r.digest).map(r => ({ id: r.id, role: r.role, actor: r.actor, digest: r.digest, tokens: r.tokens, baseVersion: value.records[r.id]?.version }));
    const removed = Object.entries(value.records).filter(([id]) => !live.has(id)).map(([id, row]) => ({ id, baseVersion: row.version }));
    const items = [...changes.map(record => ({ record })), ...removed.map(remove => ({ remove }))];
    let status: ConsolidationStatus | undefined;
    for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const result = await consolidationCall(scope, 'observe', { records: chunk.flatMap(item => 'record' in item ? [item.record] : []), removed: chunk.flatMap(item => 'remove' in item ? [item.remove] : []) }, signal) as ConsolidationStatus & { conflicts: string[]; versions: Record<string, { version: number; digest: string; retired: boolean }> };
        for (const [id, row] of Object.entries(result.versions)) {
            if (result.conflicts.includes(id)) continue;
            if (row.retired) delete value.records[id]; else value.records[id] = { version: row.version, digest: row.digest };
        }
        kvSet(key, JSON.stringify(value));
        if (result.conflicts.length) throw new Error('此设备的原对话与另一设备存在版本冲突；请先同步消息。未覆盖共享进度。');
        status = result;
    }
    status ??= await consolidationCall(scope, 'status', {}, signal);
    return { records, status };
}

/** Compression only replaces source-validated, summarized older groups. Raw storage stays intact. */
export async function projectConsolidation(scope: ConsolidationScope, history: ChatMessage[], config: ApiConfig, signal?: AbortSignal): Promise<ConsolidationProjection> {
    const { records, status } = await observeConsolidation(scope, signal);
    await noteDiagnostics(scope, { sourceGroups: records.length, excludedMessages: 0, summarySegments: 0, input: undefined, reserve: undefined, window: config.contextWindowTokens });
    if (!knownWindow(config) || !status.config.compression || !status.summary.length) return { scope, records, status, history, summary: '', excluded: 0 };
    const recent = new Set<string>(); let tokens = 0;
    for (let i = records.length - 1; i >= 0; i--) {
        if (records.length - i > status.config.recentGroups && tokens >= status.config.recentTokens) break;
        recent.add(records[i].id); tokens += records[i].tokens;
    }
    const covered = new Map(status.summary.flatMap(segment => segment.sources.map(ref => [ref.id, ref.digest] as const)));
    const omit = new Set(records.filter(r => covered.get(r.id) === r.digest && !recent.has(r.id)).flatMap(r => r.parts.map(p => p.id)));
    await noteDiagnostics(scope, { excludedMessages: omit.size, summarySegments: status.summary.length });
    return { scope, records, status, history: history.filter(m => !omit.has(m.id)), summary: status.summary.map(s => s.text).join('\n'), excluded: omit.size };
}

export type ConsolidationRun = {
    capture: (raw: string, hasTools?: boolean) => string;
    finish: () => Promise<void>;
    close: () => Promise<void>;
    job?: ConsolidationJob;
    manual?: boolean;
    noteBudget?: (values: { input: number; reserve: number; window: number; tokenKind: 'estimate' }) => void;
};
export const consolidationBudgetRun = (scope: ConsolidationScope): ConsolidationRun => ({ capture: raw => extractPrivateDecision(raw).text, finish: async () => {}, close: async () => {}, noteBudget: values => { void noteDiagnostics(scope, values).catch(() => undefined); } });

export async function beginConsolidation(projection: ConsolidationProjection, config: ApiConfig, preset: PresetConfig | null, messages: LLMMessage[], signal?: AbortSignal, immediate = false): Promise<ConsolidationRun | undefined> {
    const { scope, status, records } = projection;
    if (loadMemoryConfig().memorySource !== 'shared') return;
    if (loadMemoryConfig().automaticWritesPaused) {
        if (immediate) throw new Error('本设备已暂停程序写入，未调用整理模型。');
        return;
    }
    if (!knownWindow(config) || !config.contextWindowTokens) {
        if (immediate) throw new Error('请先为当前聊天 API 填写模型上下文窗口，再立即整理。');
        if (status.due) notifyConsolidation('已到整理阈值；尚未设置当前模型上下文窗口，待处理进度已保留。');
        return;
    }
    const reserve = preset?.openai_max_tokens && preset.openai_max_tokens > 0 ? Math.floor(preset.openai_max_tokens) : 2048;
    const room = config.contextWindowTokens - estimateTokens(JSON.stringify(messages)) - reserve - 1024;
    const budget = Math.min(status.config.taskTokens, Math.floor((room - 1200 - estimateTokens(JSON.stringify(status.summary))) / 2));
    if (budget < 1) {
        if (immediate) throw new Error('近期对话、规则与回复预留已占满当前窗口；未挤掉最近对话或调用整理模型。');
        notifyConsolidation('当前窗口没有整理空间；保留待处理进度。');
        return consolidationBudgetRun(scope);
    }
    const { key, value } = await manifest(scope);
    if (status.active && (status.active.state !== 'prepared' || status.active.expires * 1000 > Date.now())) {
        if (immediate) throw new Error('已有整理任务正在运行或等待恢复；未重复调用模型。');
        notifyConsolidation('已有整理任务正在运行或等待恢复，本轮正常聊天。');
        return consolidationBudgetRun(scope);
    }
    value.claim = crypto.randomUUID();
    const result = await consolidationCall(scope, 'prepare', { claim: value.claim, available: records.map(r => r.id), budget, immediate }, signal);
    const job = result.job;
    if (!job) return consolidationBudgetRun(scope);
    value.jobId = job.id; kvSet(key, JSON.stringify(value));
    if (job.state !== 'prepared') { notifyConsolidation('上次整理已有保存结果，请在整理面板恢复，无需重新调用模型。'); return; }
    const batch = job.inputs.map(input => records.find(r => r.id === input.id && r.digest === input.digest));
    if (batch.some(r => !r)) throw new Error('本设备缺少任务原文；未调用整理模型。');
    const selected = batch as ConsolidationRecord[];
    if (new TextEncoder().encode(JSON.stringify(selected)).byteLength > 128 * 1024) {
        await consolidationCall(scope, 'abandon', { jobId: job.id, claim: value.claim });
        throw new Error('本批原文超过128 KiB，请调小每批输入预算；未截断或调用模型。');
    }
    const instruction = consolidationInstruction(job, selected, immediate);
    if (estimateTokens(JSON.stringify([...messages, { role: 'system', content: instruction }])) + reserve + 1024 > config.contextWindowTokens) {
        await consolidationCall(scope, 'abandon', { jobId: job.id, claim: value.claim });
        notifyConsolidation('整理任务连同证据超过当前模型窗口，待处理进度已保留。');
        if (immediate) throw new Error('整理原文与规则超过模型窗口，请调整输入预算。');
        return;
    }
    insertConsolidationLayer(messages, { role: 'system', content: instruction });
    let envelope: PrivateDecisionEnvelope | undefined, staged = false, completed = false;
    const heartbeat = setInterval(() => { void consolidationCall(scope, 'heartbeat', { jobId: job.id, claim: value.claim }).catch(() => undefined); }, 30000);
    return {
        job,
        manual: immediate,
        noteBudget: values => { void noteDiagnostics(scope, values).catch(() => undefined); },
        capture(raw, hasTools = false) {
            const extracted = extractPrivateDecision(raw);
            envelope = hasTools ? undefined : extracted.envelope;
            return extracted.text;
        },
        async finish() {
            if (signal?.aborted || loadMemoryConfig().memorySource !== 'shared' || loadMemoryConfig().automaticWritesPaused) return;
            if (!envelope?.raw || envelope.error) throw new Error(envelope?.error || '本轮没有完整整理决策，待处理进度已保留。');
            const decision = validateMemoryDecision(envelope.raw, job, selected);
            // Observe edits/deletions made during generation before staging a fact.
            await observeConsolidation(scope, signal);
            staged = true;
            await consolidationCall(scope, 'stage', { claim: value.claim, jobId: job.id, decision, records: selected }, signal);
            completed = true;
            notifyConsolidation();
        },
        async close() {
            clearInterval(heartbeat);
            if (!staged && !completed) await consolidationCall(scope, 'abandon', { claim: value.claim, jobId: job.id }).catch(() => undefined);
            // A staged write with a lost response must be resumed under the
            // same durable job. Never release it and generate duplicate facts.
        },
    };
}

export async function resumeConsolidation(scope: ConsolidationScope, abandon = false) {
    const { key, value } = await manifest(scope);
    const status = await consolidationCall(scope, 'status');
    if (!status.active) return status;
    if (status.active.state !== 'prepared' || value.jobId !== status.active.id || !value.claim) {
        const claim = crypto.randomUUID();
        await consolidationCall(scope, 'adopt', { jobId: status.active.id, claim });
        value.jobId = status.active.id; value.claim = claim; kvSet(key, JSON.stringify(value));
    }
    return consolidationCall(scope, abandon ? 'abandon' : 'resume', { jobId: value.jobId, claim: value.claim });
}
