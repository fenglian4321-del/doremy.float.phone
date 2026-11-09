import { NextResponse } from 'next/server';
import { SharedMemoryError } from '@/lib/server/shared-memory';
import { xinchaoProactiveBody, xinchaoProactiveError, xinchaoProactiveHeaders as headers, xinchaoProactiveOwner } from '@/lib/server/xinchao-proactive-api';
import { emptyXinchaoProactiveSettings, validXinchaoProactiveSettings, xinchaoProactiveId } from '@/lib/xinchao-proactive-types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
    try {
        const state = xinchaoProactiveOwner(request, true); // auth before body; state-only permits shutdown with bridge disabled
        const body = await xinchaoProactiveBody(request, AbortSignal.any([request.signal, AbortSignal.timeout(8000)]));
        const keys: Record<string, string[]> = { catalog: ['operation'], list: ['operation'], configure: ['operation', 'settings'], claim: ['operation', 'deliveryId', 'claim', 'version', 'automatic'], verify: ['operation', 'deliveryId', 'claim', 'version'], finish: ['operation', 'deliveryId', 'claim', 'replyId'], dismiss: ['operation', 'deliveryId'] };
        const operation = body.operation;
        if (typeof operation !== 'string' || !Object.hasOwn(keys, operation) || Object.keys(body).sort().join(',') !== [...keys[operation]].sort().join(',')) throw new SharedMemoryError('invalid_request', '主动入口仅接受固定操作，不接受URL、提示词或工具参数。', 400);
        const enabled = process.env.FLOAT_XINCHAO_PROACTIVE_ENABLED === 'true';
        if (operation === 'catalog' || operation === 'list') return NextResponse.json({ ok: true, protocol: 'float-xinchao-proactive/v1', available: enabled && !!state.config, settings: await state.inbox?.settings() ?? emptyXinchaoProactiveSettings(), ...(operation === 'list' ? { items: await state.inbox?.list() ?? [] } : {}) }, { headers });
        if (operation === 'configure' && validXinchaoProactiveSettings(body.settings) && !body.settings.enabled) return NextResponse.json({ ok: true, protocol: 'float-xinchao-proactive/v1', available: enabled && !!state.config, settings: state.inbox ? await state.inbox.configure(body.settings) : emptyXinchaoProactiveSettings() }, { headers });
        const active = xinchaoProactiveOwner(request);
        if (!enabled || !active.inbox) throw new SharedMemoryError('xinchao_inbox_disabled', '主动能力尚未在服务端启用。', 503);
        let result;
        if (operation === 'configure') {
            if (!validXinchaoProactiveSettings(body.settings)) throw new SharedMemoryError('invalid_request', '主动设置无效。', 400);
            result = { settings: await active.inbox.configure(body.settings) };
        } else {
            if (!xinchaoProactiveId(body.deliveryId) || ((operation === 'claim' || operation === 'verify' || operation === 'finish') && !xinchaoProactiveId(body.claim)) || ((operation === 'claim' || operation === 'verify') && (!Number.isSafeInteger(body.version) || Number(body.version) < 0)) || (operation === 'claim' && typeof body.automatic !== 'boolean') || (operation === 'finish' && !xinchaoProactiveId(body.replyId))) throw new SharedMemoryError('invalid_request', '主动回执标识无效。', 400);
            if (operation === 'claim') result = await active.inbox.claim(body.deliveryId, body.claim as string, body.version as number, body.automatic as boolean);
            else if (operation === 'verify') result = await active.inbox.verifyClaim(body.deliveryId, body.claim as string, body.version as number);
            else if (operation === 'finish') result = { item: await active.inbox.finish(body.deliveryId, body.claim as string, body.replyId as string) };
            else result = { item: await active.inbox.dismiss(body.deliveryId) };
        }
        return NextResponse.json({ ok: true, protocol: 'float-xinchao-proactive/v1', available: true, ...result }, { headers });
    } catch (error) { const result = xinchaoProactiveError(error); return NextResponse.json(result.body, { status: result.status, headers }); }
}
