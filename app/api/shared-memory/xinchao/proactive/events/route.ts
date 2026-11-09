import { NextResponse } from 'next/server';
import { createXinchaoBridge } from '@/lib/server/xinchao-bridge';
import { SharedMemoryError } from '@/lib/server/shared-memory';
import { xinchaoProactiveError, xinchaoProactiveHeaders as headers, xinchaoProactiveOwner } from '@/lib/server/xinchao-proactive-api';
import { xinchaoProactiveQuiet } from '@/lib/xinchao-proactive-types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function POST(request: Request) {
    try {
        const { config, inbox } = xinchaoProactiveOwner(request);
        if (request.body) {
            const reader = request.body.getReader(), budget = AbortSignal.any([request.signal, AbortSignal.timeout(2000)]), cancel = () => { void reader.cancel().catch(() => undefined); };
            budget.addEventListener('abort', cancel, { once: true });
            try { while (true) { budget.throwIfAborted(); const part = await reader.read(); if (part.done) break; if (part.value.byteLength) throw new SharedMemoryError('invalid_request', '主动订阅不接受操作参数。', 400); } budget.throwIfAborted(); }
            finally { budget.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        }
        if (!config?.bridge || !inbox) throw new SharedMemoryError('xinchao_inbox_disabled', '服务端未启用主动桥。', 503);
        const settings = await inbox.settings();
        if (!settings.enabled) throw new SharedMemoryError('xinchao_inbox_disabled', '请先明确选择生活私聊并启用主动接收。', 409);
        const stop = new AbortController(), signal = AbortSignal.any([request.signal, stop.signal, AbortSignal.timeout(27000)]);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                let closed = false;
                const send = (event: string, value: unknown) => { if (!closed && !signal.aborted) controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n')); };
                const monitor = setInterval(() => { void inbox.settings().then(current => { if (!current.enabled || current.version !== settings.version) stop.abort(); }).catch(() => stop.abort()); }, 1000);
                void (async () => {
                    try {
                        send('ready', { protocol: 'float-xinchao-proactive-stream/v1', version: settings.version });
                        const initial = await inbox.list();
                        send('inbox', { items: initial });
                        await createXinchaoBridge(config.bridge!).subscribe(async id => {
                            const item = await inbox.receive(id, signal), current = await inbox.settings();
                            if (!current.enabled || current.version !== settings.version) { stop.abort(); return; }
                            send('inbox', { items: [item] });
                            if (item.state === 'pending' && current.offlineNotify && !xinchaoProactiveQuiet(current)) send('notify', { deliveryId: item.deliveryId, sessionId: current.sessionId, cooldownMinutes: current.cooldownMinutes });
                        }, signal);
                    } catch { send('paused', { code: 'stream_interrupted' }); }
                    finally { clearInterval(monitor); closed = true; try { controller.close(); } catch { /* consumer cancelled */ } }
                })();
            },
            cancel() { stop.abort(); },
        });
        return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream;charset=utf-8', 'X-Accel-Buffering': 'no' } });
    } catch (error) { const result = xinchaoProactiveError(error); return NextResponse.json(result.body, { status: result.status, headers }); }
}
