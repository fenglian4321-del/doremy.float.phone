import { SharedMemoryError } from './shared-memory';
import { checkXinchaoHealth, readXinchaoConfig } from './xinchao';
import type { InnerAction, InnerControls, InnerDocument, InnerModule } from '../xinchao-inner-types';
import { INNER_MODULES } from '../xinchao-inner-types';
import { createHash, randomUUID } from 'node:crypto';
const PROTOCOL = 'float-xinchao-inner/v1';
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, status = 502): never {
    throw new SharedMemoryError(code, message, status);
}
const opaque = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const exact = (v: unknown, keys: string[]) => {
    if (!obj(v) || Object.keys(v).sort().join() !== [...keys].sort().join())
        fail('inner_input', '内室请求参数不匹配。', 400);
};
export function createXinchaoInner(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
    const config = readXinchaoConfig(env);
    if (env.FLOAT_XINCHAO_INNER_CONTRACT !== 'float-xinchao-inner/v1-2abe7fa9')
        fail('inner_unconfigured', '心潮完整模块扩展尚未安装并核对，旧版只读连接仍可独立使用。', 503);
    async function json(response: Response) {
        if (!response.ok) {
            await response.body?.cancel();
            return fail(
                response.status === 409 ? 'inner_conflict' : 'inner_unavailable',
                response.status === 409
                    ? '状态已变化或操作未确认，请刷新并核对原回执。'
                    : '心潮模块尚未完成操作；请检查服务配置，未自动重试。',
                response.status === 409 ? 409 : 502,
            );
        }
        if (!response.headers.get('content-type')?.includes('application/json'))
            fail('inner_protocol', '心潮模块协议未匹配。');
        const reader = response.body?.getReader();
        if (!reader) fail('inner_protocol', '心潮模块未返回数据。');
        let count = 0,
            text = '';
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                count += part.value.byteLength;
                if (count > 2 * 1024 * 1024) fail('inner_capacity', '模块响应超过容量，未转存或截断正文。');
                text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
            if (text.includes(config.token)) fail('inner_protocol', '模块响应包含受保护配置，未返回。');
            return JSON.parse(text) as unknown;
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
    async function request(
        path: '/float/v1' | '/mcp',
        body: Record<string, unknown>,
        signal?: AbortSignal,
        session?: string,
    ) {
        const budget = AbortSignal.any([
            AbortSignal.timeout(path === '/mcp' ? 30000 : 90000),
            ...(signal ? [signal] : []),
        ]);
        budget.throwIfAborted();
        let response: Response;
        try {
            response = await fetcher(config.baseUrl + path, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + config.token,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'MCP-Protocol-Version': '2025-06-18',
                    ...(session ? { 'Mcp-Session-Id': session } : {}),
                },
                body: JSON.stringify(body),
                cache: 'no-store',
                redirect: 'error',
                signal: budget,
            });
        } catch {
            return fail('inner_uncertain', '模块请求中断；可能已执行，请核对回执，不会自动重做。');
        }
        return { value: await json(response), session: response.headers.get('mcp-session-id') };
    }
    async function call(body: Record<string, unknown>, signal?: AbortSignal) {
        await checkXinchaoHealth(config, signal, fetcher);
        const v = (await request('/float/v1', body, signal)).value;
        if (!obj(v) || v.protocol !== PROTOCOL) fail('inner_protocol', '已部署模块扩展的协议不匹配。');
        return v;
    }
    function project(v: unknown, module: InnerModule): InnerDocument {
        if (
            !obj(v) ||
            v.module !== module ||
            !['available', 'disabled', 'restricted'].includes(String(v.status)) ||
            typeof v.at !== 'string' ||
            typeof v.summary !== 'string' ||
            v.summary.length > 2000 ||
            !obj(v.controls) ||
            !Array.isArray(v.metrics) ||
            v.metrics.length > 64 ||
            !Array.isArray(v.records) ||
            v.records.length > 200
        )
            fail('inner_protocol', '心潮模块数据格式不符。');
        const c = v.controls;
        if (
            !Number.isSafeInteger(c.revision) ||
            !['inherit', 'paused'].includes(String(c.generation)) ||
            !['inherit', 'paused'].includes(String(c.jarGeneration)) ||
            !['toolsConfigured', 'modelConfigured', 'jarConfigured', 'privateText', 'shadow'].every(
                (k) => typeof c[k] === 'boolean',
            ) ||
            !Number.isFinite(c.cycleMinutes) ||
            (c.binding !== null &&
                (!obj(c.binding) ||
                    !opaque(c.binding.characterId) ||
                    typeof c.binding.name !== 'string' ||
                    typeof c.binding.coreHash !== 'string' ||
                    !/^[a-f0-9]{64}$/.test(c.binding.coreHash)))
        )
            fail('inner_protocol', '心潮控制状态格式不符。');
        const metrics = v.metrics.map((r) => {
            if (
                !obj(r) ||
                typeof r.key !== 'string' ||
                typeof r.label !== 'string' ||
                typeof r.value !== 'number' ||
                !Number.isFinite(r.value) ||
                typeof r.unit !== 'string'
            )
                fail('inner_protocol', '状态指标无效。');
            return { key: r.key, label: r.label, value: r.value, unit: r.unit };
        });
        const records = v.records.map((r) => {
            if (
                !obj(r) ||
                typeof r.id !== 'string' ||
                typeof r.title !== 'string' ||
                typeof r.text !== 'string' ||
                r.text.length > 8000 ||
                r.title.length > 160
            )
                fail('inner_protocol', '模块记录格式无效。');
            return {
                id: r.id,
                title: r.title,
                text: r.text,
                ...(typeof r.at === 'string' ? { at: r.at } : {}),
                ...(typeof r.meta === 'string' ? { meta: r.meta } : {}),
                ...(typeof r.locked === 'boolean' ? { locked: r.locked } : {}),
                ...(r.from === 'user' || r.from === 'ai' ? { from: r.from as 'user' | 'ai' } : {}),
                ...(typeof r.read === 'boolean' ? { read: r.read } : {}),
            };
        });
        return {
            module,
            status: v.status as InnerDocument['status'],
            at: v.at,
            summary: v.summary,
            metrics,
            records,
            controls: {
                revision: Number(c.revision),
                generation: c.generation as InnerControls['generation'],
                jarGeneration: c.jarGeneration as InnerControls['jarGeneration'],
                binding: c.binding
                    ? {
                          characterId: String(c.binding.characterId),
                          coreHash: String(c.binding.coreHash),
                          name: String(c.binding.name),
                      }
                    : null,
                cycleMinutes: Number(c.cycleMinutes),
                toolsConfigured: !!c.toolsConfigured,
                modelConfigured: !!c.modelConfigured,
                jarConfigured: !!c.jarConfigured,
                privateText: !!c.privateText,
                shadow: !!c.shadow,
            },
        };
    }
    async function read(module: InnerModule, signal?: AbortSignal) {
        if (!INNER_MODULES.includes(module)) fail('inner_input', '未知模块。', 400);
        return project((await call({ operation: 'read', module }, signal)).document, module);
    }
    async function mcp(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
        const initialized = await request(
            '/mcp',
            {
                jsonrpc: '2.0',
                id: 'init',
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'float-inner', version: '1' },
                },
            },
            signal,
        );
        if (
            !obj(initialized.value) ||
            !obj(initialized.value.result) ||
            !initialized.session ||
            !/^[A-Za-z0-9._~-]{1,120}$/.test(initialized.session)
        )
            fail('inner_mcp', '心潮AI工具接口尚未启用或协议不符。');
        const id = randomUUID(),
            v = (
                await request(
                    '/mcp',
                    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
                    signal,
                    initialized.session,
                )
            ).value;
        if (
            !obj(v) ||
            v.id !== id ||
            !obj(v.result) ||
            v.result.isError === true ||
            !Array.isArray(v.result.content) ||
            v.result.content.length > 16
        )
            fail('inner_mcp', '原心潮工具未确认成功，请核对记录。');
        const chunks = v.result.content
            .map((p) => {
                if (!obj(p) || p.type !== 'text' || typeof p.text !== 'string')
                    fail('inner_mcp', '工具返回不支持的数据。');
                return p.text;
            })
            .join('\n');
        if (chunks.length > 16000) fail('inner_capacity', '工具正文超过本轮容量，未截断或全量保存。');
        return chunks;
    }
    return {
        read,
        async mutate(requestId: string, revision: number, input: InnerAction, signal?: AbortSignal) {
            if (!opaque(requestId) || !Number.isSafeInteger(revision))
                fail('inner_input', '操作标识无效。', 400);
            const v = await call({ operation: 'mutate', requestId, revision, input }, signal);
            if (v.requestId !== requestId || !['complete', 'uncertain'].includes(String(v.state)))
                fail('inner_protocol', '操作回执格式不符。');
            return { requestId, state: v.state, replayed: v.replayed === true };
        },
        async receipt(requestId: string, signal?: AbortSignal) {
            if (!opaque(requestId)) fail('inner_input', '回执标识无效。', 400);
            const v = await call({ operation: 'receipt', requestId }, signal);
            return { requestId, state: v.state };
        },
        async tool(body: unknown, signal?: AbortSignal) {
            exact(body, ['requestId', 'context', 'args']);
            const b = body as Record<string, unknown>;
            exact(b.context, ['sessionId', 'characterId', 'coreHash']);
            const context = b.context as Record<string, unknown>,
                args = b.args as Record<string, unknown>;
            if (
                !opaque(b.requestId) ||
                !opaque(context.sessionId) ||
                !opaque(context.characterId) ||
                typeof context.coreHash !== 'string' ||
                !/^[a-f0-9]{64}$/.test(context.coreHash) ||
                !obj(args) ||
                typeof args.action !== 'string'
            )
                fail('inner_input', '仅接受实际绑定私聊的工具请求。', 400);
            const action = args.action,
                names: Record<string, string> = {
                    box_list: 'xinchao_box',
                    box_read: 'xinchao_box',
                    box_put: 'xinchao_box',
                    box_unpin: 'xinchao_box',
                    box_burn: 'xinchao_box',
                    cabin_inbox: 'xinchao_cabin_inbox',
                    cabin_note: 'xinchao_cabin_note',
                };
            if (!names[action])
                fail('inner_input', '此动作未提供给角色，不能修改固定核心或自动写长期记忆。', 400);
            const fields: Record<string, string[]> = {
                box_list: ['action'],
                box_read: ['action', 'id'],
                box_put: ['action', 'text'],
                box_unpin: ['action', 'id'],
                box_burn: ['action', 'id'],
                cabin_inbox: ['action'],
                cabin_note: ['action', 'content'],
            };
            exact(args, fields[action]);
            if ('id' in args && (typeof args.id !== 'string' || !args.id.trim() || args.id.length > 80))
                fail('inner_input', '条目标识无效。', 400);
            if (
                'text' in args &&
                (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 2000)
            )
                fail('inner_input', '匣子文字需为1–2000字。', 400);
            if (
                'content' in args &&
                (typeof args.content !== 'string' || !args.content.trim() || args.content.length > 8000)
            )
                fail('inner_input', '信件文字需为1–8000字。', 400);
            const doc = await read('core', signal),
                binding = doc.controls.binding;
            if (
                !binding ||
                binding.characterId !== context.characterId ||
                binding.coreHash !== context.coreHash
            )
                fail('inner_binding', '固定角色或核心已改变，请由本人在心潮核对绑定。', 409);
            const fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex');
            const reserved = await call(
                { operation: 'ai_reserve', requestId: b.requestId, context, tool: action, fingerprint },
                signal,
            );
            if (reserved.replayed === true)
                return { state: reserved.state, replayed: true, untrustedData: true };
            const toolArgs = action.startsWith('box_')
                ? {
                      action: action.slice(4),
                      ...(args.id ? { id: args.id } : {}),
                      ...(args.text ? { text: args.text } : {}),
                  }
                : action === 'cabin_note'
                  ? { event_id: 'float:' + b.requestId, content: args.content }
                  : {};
            const text = await mcp(names[action], toolArgs, signal);
            const completed = await call(
                { operation: 'ai_complete', requestId: b.requestId, context, tool: action, fingerprint },
                signal,
            );
            if (completed.state !== 'complete') fail('inner_uncertain', '工具结果未确认，不自动重做。');
            return { state: 'complete', untrustedData: true, text, receiptId: b.requestId };
        },
    };
}
