import type { SharedMemoryCandidate, SharedMemoryDetail, SharedMemoryHistory, SharedMemoryImportBatch, SharedMemoryImportReceipt, SharedMemoryImportRollback, SharedMemoryManagedEntry, SharedMemoryManagementIntent, SharedMemoryManagementReceipt, SharedMemoryPolicy, SharedMemoryReviewDetail } from "../shared-memory-types";
import { validateOrbisNote } from "../orbis-memory-import";
import { readSharedMemoryJson, SharedMemoryError, validateSharedMemoryId, type SharedMemoryConfig } from "./shared-memory";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const detail = (value: unknown): value is SharedMemoryDetail => object(value) && typeof value.id === "string" && typeof value.content === "string" && object(value.metadata);
const policy = (value: unknown): value is SharedMemoryPolicy => object(value) && typeof value.paused === "boolean" && typeof value.reviewRequired === "boolean" && version(value.version);
const candidate = (value: unknown): value is SharedMemoryCandidate => object(value)
    && typeof value.id === "string" && typeof value.targetId === "string" && typeof value.content === "string"
    && (value.kind === "create" || value.kind === "edit") && object(value.source)
    && (value.before === null || detail(value.before)) && version(value.version)
    && ["pending", "applying", "conflict", "approved", "rejected"].includes(String(value.state))
    && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
const history = (value: unknown): value is SharedMemoryHistory => object(value)
    && typeof value.id === "string" && typeof value.targetId === "string"
    && (value.before === null || detail(value.before)) && detail(value.after)
    && digest(value.afterRevision) && object(value.source) && typeof value.at === "string";
const protocolError = () => new SharedMemoryError("review_protocol", "共享审核扩展版本或返回格式不匹配，未开放写入。", 502);

const messages: Record<string, string> = {
    work_history_capacity: "文件历史达到每文件128版或本区8MiB上限；未删除旧版或保存新内容。",
    work_version_missing: "此文件版本未被保留；安装前的历史不能重建。",
    work_context: "摘要任务、格式或可整理范围不匹配；请核对提示与较早对话，原文和旧摘要保留。",
    work_context_changed: "摘要来源或人工版本已变化；未覆盖新版，也未静默省略原文。",
    work_schema: "工作区操作参数不匹配，未转交其他工具。",
    work_attachment: "一次最多6份本区文字附件；请核对路径、版本和重复项。",
    work_input: "工作消息、模型或请求标识无效，未调用其他工具。",
    work_title: "工作区名称需为1–120字节（中文约40字）。",
    work_operation: "工作区不提供生活记忆、设备或外部执行操作。",
    work_scope: "任务或文件不属于当前工作区。",
    work_missing: "工作区不存在，请刷新。",
    work_busy: "当前工作区已有任务，请等待、恢复或结束同一任务。",
    work_claim: "任务恢复标识不匹配，请显式接管已停止的任务。",
    work_expired: "任务租约过期；工作记录与已完成文件操作仍保留。",
    work_inactive: "工作任务已停止或结束，请刷新后恢复。",
    work_conflict: "工作区已在另一设备变更，未覆盖新版，请刷新。",
    work_archived: "工作区已归档，需由用户恢复后才能写入。",
    work_path: "仅支持当前工作区内的相对文件路径。",
    work_file_conflict: "工作文件已修改；请先读取新版，不会覆盖人工内容。",
    work_file_missing: "当前工作区内没有此文件。",
    work_file_capacity: "工作文件超过容量，未截断或删除旧文件。",
    work_capacity: "工作区或任务已达保留容量，未截断或删除内容。",
    work_tool_forbidden: "独立工作区仅允许当前工作文件工具。",
    work_turn_limit: "请先恢复未完成动作；每个工作任务最多8轮工具调用。",
    work_finish: "仍有未完成动作、任务已停止或最终回复无效，工作进度保留。",
    work_client_upgrade: "任务需要确认固定执行位置，请刷新配套客户端后核对；未回退或重放工具。",
    invalid_scope: "请选择具体对话与角色。",
    invalid_config: "整理设置或预算超出范围，请核对后重试。",
    version_conflict: "另一设备修改过整理设置，请刷新。",
    claim_conflict: "整理任务正在另一请求或设备上进行。",
    lease_expired: "整理任务租约已过期；待处理进度仍保留。",
    memory_changed: "正式记忆已有其他修改；保留人工版本，请核对后重新整理。",
    config_changed: "整理期间设置或摘要已改变，未覆盖新版。",
    source_changed: "原消息已编辑、重生成或移除；未保存过时结论。",
    messages_unavailable: "较早的待整理消息不在此设备；请先同步原对话。",
    input_over_budget: "最早的消息组超过整理预算；未截断，请调整输入预算。",
    decision_missing: "尚未收到有效整理决策；进度未清零，也未再次调用模型。",
    decision_conflict: "同一任务不能换另一份整理结果。",
    job_busy: "另一设备仍在生成，请等待完成或租约到期。",
    job_inactive: "此任务已结束或由新任务取代，请刷新。",
    job_missing: "整理任务不存在，请刷新进度。",
    invalid_evidence: "证据不是逐字原话或说话人不匹配；未保存。",
    invalid_proof: "原文证据不完整或格式异常；未保存。",
    invalid_summary: "续聊摘要缺少有效来源或超过容量；进度未清零。",
    manual_disabled: "此对话未开启手动整理。",
    conflict: "内容或状态已在别处变更，未覆盖新版。请刷新后核对。",
    idempotency_conflict: "同一提交编号已用于不同内容，请核对原提案。",
    paused: "共享记忆写入已暂停，待确认内容仍保留。",
    uncertain: "写入结果待核对，请恢复同一待确认记录，勿新建重复提案。",
    no_change: "正文没有变化，无需写入。",
    unsupported_undo: "仅支持撤销已有记忆的正文修改，且此后不能有其他修改。",
    not_found: "共享记忆或审核记录不存在。",
    rejected: "同一操作之前已被忽略，不会再次写入。",
    invalid_content: "正文需为 1–12000 字符，且不能含危险控制字符。",
    invalid_revision: "缺少原版本，请重新读取正文后编辑。",
    invalid_request: "审核请求格式无效。",
    invalid_source: "来源信息过长或格式无效。",
    unsupported_metadata: "现有元数据格式暂不支持安全修改，未写入。",
    inactive_memory: "相同记忆已归档或移入回收站，AI 不会自动重新建立。请由用户恢复。",
    latent_unavailable: "Latent 派生召回尚未就绪；没有使用旧索引或其他来源。",
    latent_capacity: "记忆量或派生块超过当前 Latent 容量，未截断正文；请检查配置或显式选择 Ombre 召回。",
    latent_building: "Latent 语义索引正在后台构建，请稍后重试；未使用旧索引。",
    latent_busy: "Latent 语义查询繁忙，请稍后重试。",
    embedding_unavailable: "Latent embedding 服务未就绪，未使用旧向量或其他来源。",
    invalid_import: "Orbis 条目格式、状态或容量不受支持，未截断导入。",
    import_conflict: "此 Orbis 条目已导入过不同版本或已撤销；不会覆盖现有修改或自动复活，请人工核对。",
};

/** Our explicitly installed v2 add-on, not an invented upstream Ombre API. */
export function createOmbreReviewClient(config: SharedMemoryConfig, fetcher: typeof fetch = fetch) {
    async function call(action: string, method = "GET", payload?: Record<string, unknown>, id?: string, query?: string, extra?: Record<string, string>): Promise<Record<string, unknown>> {
        if (!config.reviewToken) throw new SharedMemoryError("review_unconfigured", "尚未配置共享审核扩展，仍可只读浏览。", 501);
        if (id !== undefined) validateSharedMemoryId(id);
        let response: Response;
        try {
            const params = new URLSearchParams();
            if (id) params.set("id", id);
            if (query) params.set("q", query);
            for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
            response = await fetcher(`${config.baseUrl}/float-memory/v2/${action}${params.size ? `?${params}` : ""}`, {
                method, headers: { Authorization: `Bearer ${config.reviewToken}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
                body: payload ? JSON.stringify(payload) : undefined,
                cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
            });
        } catch {
            throw new SharedMemoryError("review_unreachable", method === "POST"
                ? "审核服务响应未确认；请刷新同一记录核对，勿重复新建提案。"
                : "无法读取审核服务，请稍后重试。", 503);
        }
        if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            throw new SharedMemoryError("review_auth", "共享审核服务鉴权失败，请检查服务端配置。", 502);
        }
        if (response.status === 404 && !response.headers.get("content-type")?.includes("application/json")) {
            await response.body?.cancel();
            throw new SharedMemoryError("review_unavailable", "当前 Ombre 尚未安装审核扩展，仍可只读浏览。", 501);
        }
        const body = await readSharedMemoryJson(response);
        if (!object(body)) throw protocolError();
        if (!response.ok || body.ok !== true) {
            const code = typeof body.code === "string" ? body.code : "review_unavailable";
            throw new SharedMemoryError(code, messages[code] ?? "共享审核扩展不可用或版本不匹配，未开放写入。", response.status === 400 || response.status === 404 || response.status === 409 ? response.status : 502);
        }
        return body;
    }
    return {
        async privateSpaces(payload: Record<string, unknown>) {
            const body = await call("private_spaces", "POST", payload);
            if (body.protocol !== "float-private-spaces/v1") throw protocolError();
            return body;
        },
        async workspaces(payload: Record<string, unknown>) {
            const body = await call("workspaces", "POST", payload);
            if (body.protocol !== "float-workspaces/v1") throw protocolError();
            return body;
        },
        async consolidation(payload: Record<string, unknown>) {
            const body = await call("consolidation", "POST", payload);
            if (body.protocol !== "float-consolidation/v1") throw protocolError();
            return body;
        },
        async status() {
            if (!config.reviewToken) return { available: false as const };
            const body = await call("status");
            if (body.protocol !== "float-review/v2" || !policy(body.policy) || !(body.latent === false || (body.latent === true && ["lexical-graph-v1", "semantic-hybrid-v1"].includes(String(body.latentMode)))) || typeof body.nativeWritesReviewed !== "boolean") throw protocolError();
            const latentIndexState = ["unstarted", "building", "ready", "outdated", "error"].includes(String(body.latentIndexState)) ? String(body.latentIndexState) : undefined;
            return { available: true as const, policy: body.policy, nativeWritesReviewed: body.nativeWritesReviewed, management: body.management === true, latent: body.latent === true, latentMode: body.latent === true ? body.latentMode as "lexical-graph-v1" | "semantic-hybrid-v1" : undefined, latentIndexState, orbisImport: body.orbisImport === true };
        },
        async detail(id: string): Promise<SharedMemoryReviewDetail> {
            const body = await call("detail", "GET", undefined, id);
            if (!detail(body.entry) || !digest((body.entry as SharedMemoryReviewDetail).revision) || body.entry.id !== id) throw protocolError();
            return body.entry as SharedMemoryReviewDetail;
        },
        async candidates() {
            const body = await call("candidates");
            if (!Array.isArray(body.candidates) || !body.candidates.every(candidate) || typeof body.total !== "number" || !Number.isSafeInteger(body.total) || body.total < body.candidates.length) throw protocolError();
            return { candidates: body.candidates, total: body.total };
        },
        async history(id: string) {
            const body = await call("history", "GET", undefined, id);
            if (!Array.isArray(body.history) || !body.history.every(history)) throw protocolError();
            return body.history;
        },
        async memories(query?: string, engine = "ombre"): Promise<SharedMemoryReviewDetail[]> {
            if (query && query.length > 500) throw new SharedMemoryError("invalid_query", "检索词最多 500 字符。", 400);
            if (!["ombre", "latent"].includes(engine)) throw new SharedMemoryError("invalid_request", "召回方式无效。", 400);
            const body = await call("memories", "GET", undefined, undefined, query, engine === "latent" ? { engine } : undefined);
            if (!Array.isArray(body.entries) || !body.entries.every(item => detail(item) && digest((item as SharedMemoryReviewDetail).revision))) throw protocolError();
            return body.entries as SharedMemoryReviewDetail[];
        },
        async catalog(state: string, cursor?: string) {
            if (!["active", "archived", "deleted"].includes(state)) throw new SharedMemoryError("invalid_request", "管理筛选无效。", 400);
            if (cursor) validateSharedMemoryId(cursor);
            const body = await call("catalog", "GET", undefined, undefined, undefined, { state, ...(cursor ? { cursor } : {}) });
            if (!Array.isArray(body.entries) || body.entries.length > 100 || !body.entries.every(item => detail(item) && digest((item as SharedMemoryManagedEntry).revision) && (item as SharedMemoryManagedEntry).state === state)
                || (body.nextCursor !== null && typeof body.nextCursor !== "string") || !Array.isArray(body.pending)
                || !body.pending.every(item => object(item) && typeof item.targetId === "string" && typeof item.clientKey === "string" && digest(item.baseRevision) && ["archive", "delete", "restore"].includes(String(item.operation)))) throw protocolError();
            return { entries: body.entries as SharedMemoryManagedEntry[], nextCursor: body.nextCursor as string | null, pending: body.pending as SharedMemoryManagementIntent[] };
        },
        async importBatches() {
            const body = await call("import_batches");
            if (!Array.isArray(body.batches) || body.batches.length > 30 || !body.batches.every(item => object(item) && typeof item.id === "string" && typeof item.at === "string" && [item.total, item.created, item.undone, item.pending].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0))) throw protocolError();
            return { batches: body.batches as SharedMemoryImportBatch[] };
        },
        async mutate(action: string, payload: Record<string, unknown>) {
            if (!["record", "save", "propose", "revise", "approve", "reject", "undo", "undo_save", "policy", "recall", "manage", "import_note", "import_rollback"].includes(action)) throw new SharedMemoryError("invalid_action", "不支持的共享审核操作。", 400);
            if (action === "import_note") {
                const source = object(payload.note) ? payload.note : {};
                if (typeof source.assistantId !== "string" || validateOrbisNote(source, source.assistantId).error) throw new SharedMemoryError("invalid_import", "Orbis 条目无效或超过容量，未上传。", 400);
            }
            const body = await call(action, "POST", payload);
            if (action === "import_note") {
                const receipt = body.importReceipt;
                if (!object(receipt) || typeof receipt.targetId !== "string" || typeof receipt.batchId !== "string" || !["created", "existing"].includes(String(receipt.state)) || typeof receipt.owned !== "boolean") throw protocolError();
                return { importReceipt: receipt as SharedMemoryImportReceipt };
            }
            if (action === "import_rollback") {
                if (!Array.isArray(body.results) || body.results.length > 20 || !body.results.every(item => object(item) && (item.targetId === null || typeof item.targetId === "string") && ["kept_existing", "applying", "rolled_back", "needs_review"].includes(String(item.state))) || (body.nextCursor !== null && typeof body.nextCursor !== "string")) throw protocolError();
                return { results: body.results as SharedMemoryImportRollback[], nextCursor: body.nextCursor as string | null };
            }
            if (action === "manage") {
                const receipt = body.management;
                if (!object(receipt) || typeof receipt.id !== "string" || receipt.targetId !== payload.targetId || receipt.operation !== payload.operation || !["applying", "completed", "conflict"].includes(String(receipt.state))) throw protocolError();
                return { management: receipt as SharedMemoryManagementReceipt };
            }
            if (action === "recall") {
                if (typeof body.touched !== "number" || !Number.isSafeInteger(body.touched) || body.touched < 0) throw protocolError();
                return { touched: body.touched };
            }
            if (action === "policy") {
                if (!policy(body.policy)) throw protocolError();
                return { policy: body.policy };
            }
            if (!candidate(body.candidate)) throw protocolError();
            return { candidate: body.candidate };
        },
    };
}
