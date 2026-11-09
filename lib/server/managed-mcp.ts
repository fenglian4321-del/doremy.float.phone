import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ManagedMcpError, MANAGED_MCP_PROTOCOL, mcpCanonical, mcpExact, mcpId, mcpObject, mcpScope, validateManagedMcpSchema, validateManagedMcpArguments, type ManagedMcpBinding, type ManagedMcpScope, type ManagedMcpService, type ManagedMcpReceipt, type ManagedMcpReply } from '../managed-mcp-policy';
import { createManagedMcpTransport, managedMcpUrl, type ManagedMcpTransportDeps } from './managed-mcp-transport';

type Service = ManagedMcpService & { url: URL; token: string; modes: string[] };
export type ManagedMcpConfig = { root: string; key: string; services: Service[] };
const emptyBinding = (): ManagedMcpBinding => ({ version: 0, enabled: false, services: [] });
export function readManagedMcpConfig(env: NodeJS.ProcessEnv = process.env): ManagedMcpConfig | null {
    if (env.FLOAT_MANAGED_MCP_ENABLED !== 'true') return null;
    const root = env.FLOAT_MANAGED_MCP_STATE_DIR, key = env.FLOAT_MANAGED_MCP_LEDGER_KEY;
    if (!root || !path.isAbsolute(root) || !key || key.length < 32 || key.length > 512) throw new ManagedMcpError('configuration', '受控MCP需配置独立私有回执目录和密钥。', 503);
    const encoded = env.FLOAT_MANAGED_MCP_SERVICES_JSON || '[]';
    if (Buffer.byteLength(encoded) > 131072) throw new ManagedMcpError('configuration', 'MCP服务配置超过容量。', 503);
    let rows: unknown; try { rows = JSON.parse(encoded); } catch { throw new ManagedMcpError('configuration', 'MCP服务配置无效。', 503); }
    if (!Array.isArray(rows) || rows.length > 8) throw new ManagedMcpError('configuration');
    const ids = new Set<string>();
    const services = rows.map(raw => {
        mcpExact(raw, ['id', 'name', 'url', 'tokenEnv', 'modes', 'tools']); mcpId(raw.id);
        if (ids.has(raw.id) || Object.hasOwn(Object.prototype, raw.id) || typeof raw.name !== 'string' || raw.name.length > 80 || !Array.isArray(raw.modes) || !raw.modes.length || raw.modes.some(mode => !['work', 'private'].includes(mode)) || new Set(raw.modes).size !== raw.modes.length || !Array.isArray(raw.tools) || !raw.tools.length || raw.tools.length > 32) throw new ManagedMcpError('configuration');
        ids.add(raw.id);
        const url = managedMcpUrl(raw.url), names = new Set<string>();
        let token = '';
        if (raw.tokenEnv !== undefined) {
            if (typeof raw.tokenEnv !== 'string' || !/^FLOAT_MCP_SERVICE_TOKEN_[A-Z0-9_]{1,60}$/.test(raw.tokenEnv)) throw new ManagedMcpError('configuration');
            token = env[raw.tokenEnv] || '';
            if (!/^[\x21-\x7e]{16,2048}$/.test(token) || token === key) throw new ManagedMcpError('configuration', '服务凭据未配置或格式不兼容。', 503);
        }
        const tools = raw.tools.map(tool => {
            mcpExact(tool, ['name', 'description', 'inputSchema', 'readOnly']);
            if (typeof tool.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name) || typeof tool.description !== 'string' || tool.description.length > 512 || tool.readOnly !== true) throw new ManagedMcpError('configuration', '首版仅支持管理员明确列出的只读工具。', 503);
            names.add(tool.name); validateManagedMcpSchema(tool.inputSchema);
            if (tool.inputSchema.type !== 'object') throw new ManagedMcpError('configuration');
            return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
        });
        const revision = createHmac('sha256', key).update(mcpCanonical(['service-policy-v1', raw.id, url.href, raw.modes, tools, token])).digest('hex');
        if ((token && mcpCanonical({ id: raw.id, name: raw.name, tools }).includes(token)) || mcpCanonical(tools).includes(key)) throw new ManagedMcpError('configuration');
        return { id: raw.id, name: raw.name, url, token, modes: raw.modes as string[], tools, revision };
    });
    const publicView = mcpCanonical(services.map(({ id, name, revision, tools }) => ({ id, name, revision, tools })));
    if ([key, ...services.map(service => service.token).filter(Boolean)].some(secret => publicView.includes(secret))) throw new ManagedMcpError('configuration');
    return { root: path.resolve(root), key, services };
}
type RecordReceipt = ManagedMcpReceipt & { fingerprint: string; bindingVersion: number };
const fileMissing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const receiptView = (record: RecordReceipt): ManagedMcpReceipt => ({ requestId: record.requestId, serviceId: record.serviceId, tool: record.tool, state: record.state === 'reserved' && Date.now() - record.at > 35000 ? 'uncertain' : record.state, at: record.at, ...(record.code ? { code: record.code } : {}) });
export function createManagedMcpGateway(config: ManagedMcpConfig, origin: string, ensureScope: (scope: ManagedMcpScope) => Promise<void>, deps?: ManagedMcpTransportDeps) {
    const mac = (value: unknown) => createHmac('sha256', config.key).update(mcpCanonical(value)).digest('hex');
    const scopeId = (scope: ManagedMcpScope) => mac(['scope', scope]);
    const policyFile = (scope: ManagedMcpScope) => path.join(config.root, 'bindings', scopeId(scope) + '.json');
    const receiptFile = (scope: ManagedMcpScope, id: string) => path.join(config.root, 'receipts', mac([scope, id]) + '.json');
    async function json(file: string) { const value = await readFile(file); if (value.length > 65536) throw new ManagedMcpError('state', 'MCP私有状态异常，未继续执行。', 503); try { return JSON.parse(value.toString('utf8')); } catch { throw new ManagedMcpError('state', 'MCP私有状态异常。', 503); } }
    async function policy(scope: ManagedMcpScope): Promise<ManagedMcpBinding> {
        let value; try { value = await json(policyFile(scope)); } catch (error) { if (fileMissing(error)) return emptyBinding(); throw error; }
        try {
            mcpExact(value, ['version', 'enabled', 'services']);
            if (!Number.isSafeInteger(value.version) || Number(value.version) < 0 || typeof value.enabled !== 'boolean' || !Array.isArray(value.services) || value.services.length > 8) throw new Error();
            for (const grant of value.services) { mcpExact(grant, ['id', 'revision', 'tools']); mcpId(grant.id); if (typeof grant.revision !== 'string' || !/^[a-f0-9]{64}$/.test(grant.revision) || !Array.isArray(grant.tools) || !grant.tools.length || grant.tools.length > 32 || new Set(grant.tools).size !== grant.tools.length) throw new Error(); grant.tools.forEach(mcpId); }
            return value as ManagedMcpBinding;
        } catch { throw new ManagedMcpError('state', 'MCP授权私有状态异常，未连接服务。', 503); }
    }
    async function atomic(file: string, value: unknown) {
        const temporary = file + '.' + randomUUID() + '.tmp';
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
        if (process.platform !== 'win32') { const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    }
    async function lock<T>(fn: () => Promise<T>): Promise<T> {
        await mkdir(path.join(config.root, 'bindings'), { recursive: true, mode: 0o700 });
        await mkdir(path.join(config.root, 'receipts'), { recursive: true, mode: 0o700 });
        let handle; const started = Date.now();
        while (!handle) {
            try { handle = await open(path.join(config.root, 'state.lock'), 'wx', 0o600); }
            catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST' || Date.now() - started >= 1000) throw new ManagedMcpError('busy', 'MCP状态正在更新或需管理员核对，请查看原回执。', 409); await new Promise(resolve => setTimeout(resolve, 10)); }
        }
        try { return await fn(); } finally { await handle.close(); await unlink(path.join(config.root, 'state.lock')); }
    }
    function service(scope: ManagedMcpScope, id: unknown): Service {
        mcpId(id); const value = config.services.find(item => item.id === id && item.modes.includes(scope.mode));
        if (!value) throw new ManagedMcpError('service_denied', '此服务未配置给当前空间。', 403);
        return value;
    }
    async function allowed(scope: ManagedMcpScope, target: Service, tool?: string, version?: number) {
        const current = await policy(scope), grant = current.services.find(item => item.id === target.id);
        if (!current.enabled || !grant || grant.revision !== target.revision || (tool && !grant.tools.includes(tool)) || (version !== undefined && current.version !== version)) throw new ManagedMcpError('revoked', '当前空间的MCP授权已关闭、变更或未授予。', 403);
        return current;
    }
    async function readReceipt(scope: ManagedMcpScope, id: string): Promise<RecordReceipt> {
        let value; try { value = await json(receiptFile(scope, id)); } catch (error) { if (fileMissing(error)) throw new ManagedMcpError('receipt_missing', '本区没有此MCP回执；未查询其他空间。', 404); throw error; }
        try {
            mcpExact(value, ['requestId', 'serviceId', 'tool', 'state', 'at', 'code', 'fingerprint', 'bindingVersion']); mcpId(value.serviceId); mcpId(value.tool);
            if (value.requestId !== id || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !Number.isSafeInteger(value.bindingVersion) || Number(value.bindingVersion) < 0 || !Number.isSafeInteger(value.at) || Number(value.at) < 0 || !['reserved', 'complete', 'failed', 'uncertain', 'cancelled'].includes(String(value.state)) || (value.code !== undefined && (typeof value.code !== 'string' || !/^[a-z_]{1,64}$/.test(value.code)))) throw new Error();
            return value as RecordReceipt;
        } catch { throw new ManagedMcpError('state', 'MCP回执私有状态异常，未重放工具。', 503); }
    }
    return async (body: unknown, signal: AbortSignal): Promise<ManagedMcpReply> => {
        mcpExact(body, ['operation', 'scope', 'version', 'enabled', 'services', 'serviceId', 'tool', 'args', 'requestId', 'run']); mcpScope(body.scope);
        const scope = body.scope, operation = body.operation;
        const extra: Record<string, string[]> = { catalog: [], bind: ['version', 'enabled', 'services'], discover: ['serviceId'], call: ['serviceId', 'tool', 'args', 'requestId', 'run'], receipt: ['requestId'], cancel: ['requestId'] };
        if (typeof operation !== 'string' || !Object.hasOwn(extra, operation)) throw new ManagedMcpError('operation');
        mcpExact(body, ['operation', 'scope', ...extra[operation]]);
        if (body.run !== undefined) { mcpExact(body.run, ['runId', 'claim']); mcpId(body.run.runId); mcpId(body.run.claim); }
        signal.throwIfAborted(); await ensureScope(scope); signal.throwIfAborted();
        const reply = (fields: Partial<ManagedMcpReply>): ManagedMcpReply => ({ protocol: MANAGED_MCP_PROTOCOL, available: true, ...fields });
        if (operation === 'catalog') return reply({ binding: await policy(scope), services: config.services.filter(item => item.modes.includes(scope.mode)).map(({ id, name, revision, tools }) => ({ id, name, revision, tools })) });
        if (operation === 'bind') {
            if (!Number.isSafeInteger(body.version) || typeof body.enabled !== 'boolean' || !Array.isArray(body.services) || body.services.length > 8) throw new ManagedMcpError('binding');
            const ids = new Set<string>();
            const grants = body.services.map(item => {
                mcpExact(item, ['id', 'revision', 'tools']); const target = service(scope, item.id);
                if (ids.has(target.id) || item.revision !== target.revision || !Array.isArray(item.tools) || !item.tools.length || item.tools.length > 32 || new Set(item.tools).size !== item.tools.length || item.tools.some(name => typeof name !== 'string' || !target.tools.some(tool => tool.name === name))) throw new ManagedMcpError('binding');
                ids.add(target.id); return { id: target.id, revision: target.revision, tools: item.tools as string[] };
            });
            const binding = await lock(async () => {
                const previous = await policy(scope);
                if (previous.version !== body.version && body.enabled !== false) throw new ManagedMcpError('conflict', '本区MCP授权已变，请刷新后核对。', 409);
                const next: ManagedMcpBinding = { version: previous.version + 1, enabled: body.enabled as boolean, services: grants };
                await atomic(policyFile(scope), next); return next;
            });
            return reply({ binding });
        }
        if (operation === 'receipt' || operation === 'cancel') {
            mcpId(body.requestId); const id = body.requestId;
            const record = operation === 'cancel' ? await lock(async () => { const current = await readReceipt(scope, id); if (current.state === 'reserved') { current.state = 'cancelled'; current.code = 'cancelled'; await atomic(receiptFile(scope, id), current); } return current; }) : await readReceipt(scope, id);
            return reply({ receipt: receiptView(record), replayed: true });
        }
        const target = service(scope, body.serviceId), initial = await allowed(scope, target);
        const tool = operation === 'call' ? target.tools.find(item => item.name === body.tool) : undefined;
        if (operation === 'call') {
            if (!tool) throw new ManagedMcpError('tool_denied', '工具不在管理员允许目录内。', 403);
            mcpId(body.requestId); if (body.requestId.length < 16) throw new ManagedMcpError('identifier');
            validateManagedMcpArguments(body.args, tool.inputSchema);
            if (Buffer.byteLength(mcpCanonical(body.args)) > 16384) throw new ManagedMcpError('capacity', 'MCP参数超过16KiB。', 413);
            await allowed(scope, target, tool.name);
        }
        let record: RecordReceipt | undefined, discoveryLease = '';
        if (operation === 'call' && tool) {
            const id = body.requestId as string, fingerprint = mac([scope, target.id, target.revision, tool.name, body.args, mcpObject(body.run) ? body.run.runId : null]);
            const reserved = await lock(async () => {
                try { return { existing: await readReceipt(scope, id) }; } catch (error) { if (!(error instanceof ManagedMcpError) || error.code !== 'receipt_missing') throw error; }
                if ((await readdir(path.join(config.root, 'receipts'))).filter(name => name.endsWith('.json')).length >= 4096) throw new ManagedMcpError('receipt_capacity', 'MCP回执容量已满，未自动删除防重记录。', 429);
                let leases: { scope: string; id: string; expires: number }[] = [];
                try { leases = (await json(path.join(config.root, 'leases.json'))).filter((value: { expires: number }) => value.expires > Date.now()); } catch (error) { if (!fileMissing(error)) throw error; }
                if (leases.length >= 4 || leases.some(value => value.scope === scopeId(scope))) throw new ManagedMcpError('busy', '本区已有MCP操作，或服务并发已满；未新建调用。', 409);
                const created: RecordReceipt = { requestId: id, serviceId: target.id, tool: tool.name, state: 'reserved', at: Date.now(), fingerprint, bindingVersion: initial.version };
                await atomic(receiptFile(scope, id), created);
                await atomic(path.join(config.root, 'leases.json'), [...leases, { scope: scopeId(scope), id: mac([scope, id]), expires: Date.now() + 35000 }]);
                return { created };
            });
            if (reserved.existing) { if (reserved.existing.fingerprint !== fingerprint) throw new ManagedMcpError('conflict', '相同回执编号不能更换工具或参数。', 409); return reply({ receipt: receiptView(reserved.existing), replayed: true }); }
            record = reserved.created;
        }
        if (operation === 'discover') {
            discoveryLease = mac([scope, randomUUID()]);
            await lock(async () => {
                let leases: { scope: string; id: string; expires: number }[] = [];
                try { leases = (await json(path.join(config.root, 'leases.json'))).filter((value: { expires: number }) => value.expires > Date.now()); } catch (error) { if (!fileMissing(error)) throw error; }
                if (leases.length >= 4 || leases.some(value => value.scope === scopeId(scope))) throw new ManagedMcpError('busy', '本区已有外部连接，未重复发现。', 409);
                await atomic(path.join(config.root, 'leases.json'), [...leases, { scope: scopeId(scope), id: discoveryLease, expires: Date.now() + 35000 }]);
            });
        }
        const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(25000)]);
        let checkedRunAt = Date.now();
        const check = async () => {
            combined.throwIfAborted(); await allowed(scope, target, tool?.name, initial.version);
            if (record && (await readReceipt(scope, record.requestId)).state !== 'reserved') throw new ManagedMcpError('cancelled', 'MCP调用已取消。', 499);
            if (body.run !== undefined && Date.now() - checkedRunAt >= 1000) { checkedRunAt = Date.now(); await ensureScope(scope); }
            combined.throwIfAborted();
        };
        let checking = false;
        const watcher = setInterval(() => { if (!checking) { checking = true; void check().catch(error => controller.abort(error)).finally(() => { checking = false; }); } }, 200);
        try {
            const wire = createManagedMcpTransport(target.url, target.token, origin, deps);
            await check(); await wire.initialize(combined); await check();
            const listed = await wire.rpc('tools/list', {}, combined); await check();
            if (!Array.isArray(listed.tools) || listed.tools.length > 128 || listed.nextCursor !== undefined) throw new ManagedMcpError('catalog', '首版要求单页工具目录，超限或分页不截断使用。', 502);
            const selected = (await policy(scope)).services.find(item => item.id === target.id)!.tools;
            for (const name of selected) {
                const actual = listed.tools.filter(item => mcpObject(item) && item.name === name), expected = target.tools.find(item => item.name === name)!;
                if (actual.length !== 1 || !mcpObject(actual[0]) || mcpCanonical(actual[0].inputSchema) !== mcpCanonical(expected.inputSchema)) throw new ManagedMcpError('catalog_changed', '远端工具目录与管理员固定Schema不一致，未调用工具。', 409);
            }
            if (!tool || !record) return reply({ verified: true });
            await ensureScope(scope); await check(); const result = await wire.rpc('tools/call', { name: tool.name, arguments: body.args }, combined); await check();
            if (!Array.isArray(result.content) || result.content.length > 16 || result.content.some(item => !mcpObject(item) || item.type !== 'text' || typeof item.text !== 'string') || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new ManagedMcpError('result', '首版只接收文字工具结果，不下载媒体或资源。', 502);
            const text = result.content.map(item => (item as { text: string }).text).join('\n');
            if (Buffer.byteLength(text) > 32768 || (target.token && text.includes(target.token))) throw new ManagedMcpError('capacity', 'MCP结果超限或含服务凭据，未返回正文。', 413);
            await ensureScope(scope); await check();
            await lock(async () => { await check(); record!.state = result.isError ? 'failed' : 'complete'; if (result.isError) record!.code = 'tool_error'; await atomic(receiptFile(scope, record!.requestId), record); });
            return reply({ receipt: receiptView(record), text, isError: Boolean(result.isError), untrustedData: true });
        } catch (error) {
            const timeout = combined.aborted && combined.reason?.name === 'TimeoutError';
            const stopped = combined.aborted && controller.signal.aborted && controller.signal.reason instanceof ManagedMcpError ? controller.signal.reason as ManagedMcpError : undefined;
            if (record) {
                await lock(async () => { const current = await readReceipt(scope, record!.requestId); record!.state = current.state === 'cancelled' ? 'cancelled' : 'uncertain'; record!.code = timeout ? 'timeout' : stopped?.code || (combined.aborted ? 'cancelled' : error instanceof ManagedMcpError ? error.code : 'unconfirmed'); await atomic(receiptFile(scope, record!.requestId), record); });
            }
            if (timeout) throw new ManagedMcpError('timeout', 'MCP请求已超时；请核对原回执，未自动重试。', 504);
            if (stopped) throw stopped;
            if (combined.aborted) throw new ManagedMcpError('cancelled', 'MCP调用已停止；已发送请求无法撤回。', 499);
            if (error instanceof ManagedMcpError) throw error;
            throw new ManagedMcpError(combined.aborted ? 'cancelled_or_timeout' : 'unconfirmed', 'MCP执行未确认；请核对同一回执，不要自动再次调用。', combined.aborted ? 499 : 502);
        } finally {
            clearInterval(watcher);
            if (record || discoveryLease) await lock(async () => { const file = path.join(config.root, 'leases.json'); const leases = await json(file); await atomic(file, leases.filter((value: { id: string }) => value.id !== (record ? mac([scope, record.requestId]) : discoveryLease))); }).catch(() => undefined);
        }
    };
}
