import { beginUsageRequest, type UsageContext } from "./usage-ledger";
import { normalizeTokenUsage, type TokenUsage } from "./token-usage";

/** Bounded transient parsing; no bodies, prompts, URLs, headers or error text enter the ledger. */
export function createUsageCollector(streaming: boolean) {
    const limit = 256 * 1024;
    let buffer = "", carry = "", overflow = false, providerError = false;
    let usage: TokenUsage | undefined;
    let raw: Record<string, unknown> = {};
    const decoder = new TextDecoder();
    const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
    const parsed = (value: unknown) => {
        const d = object(value);
        if (d.error || d.type === "error") providerError = true;
        const source = object(d.usage ?? object(d.message).usage ?? object(d.response).usage ?? d.usageMetadata ?? object(d.output).usage);
        const selected: Record<string, unknown> = {};
        for (const key of ["prompt_tokens", "input_tokens", "completion_tokens", "output_tokens", "total_tokens", "promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "cachedContentTokenCount", "prompt_cache_hit_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
            const v = source[key];
            if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) selected[key] = v;
        }
        for (const key of ["prompt_tokens_details", "input_tokens_details", "completion_tokens_details", "output_tokens_details"]) {
            const detail = object(source[key]);
            if (typeof detail.cached_tokens === "number" || typeof detail.reasoning_tokens === "number") selected[key] = { cached_tokens: detail.cached_tokens, reasoning_tokens: detail.reasoning_tokens };
        }
        raw = { ...raw, ...selected };
        usage = normalizeTokenUsage({ usage: raw });
    };
    const event = (text: string) => {
        const payload = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("");
        if (!payload || payload === "[DONE]") { carry = ""; return; }
        try { parsed(JSON.parse(carry + payload)); carry = ""; }
        catch { try { parsed(JSON.parse(payload)); carry = ""; } catch { carry = carry.length + payload.length <= limit ? carry + payload : ""; } }
    };
    const consume = (text: string) => {
        if (overflow) return;
        buffer += text;
        if (streaming) {
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) { event(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length); }
        }
        if (buffer.length > limit) { buffer = ""; if (!streaming) overflow = true; }
    };
    return {
        push(bytes: Uint8Array) { try { consume(decoder.decode(bytes, { stream: true })); } catch { /* Unknown usage remains unknown. */ } },
        finish() { try { consume(decoder.decode()); if (streaming) { if (buffer.trim()) event(buffer); } else if (buffer) parsed(JSON.parse(buffer)); } catch { /* Accounting parser never affects the response. */ } buffer = ""; carry = ""; raw = {}; },
        usage: () => usage,
        failed: () => providerError,
    };
}

/** One entry per physical LLM/embedding HTTP attempt, including failures and consumer cancellation. */
export async function fetchWithUsage(input: RequestInfo | URL, init: RequestInit, context: UsageContext, fetcher: typeof fetch = fetch, streamingHint = false): Promise<Response> {
    const finish = beginUsageRequest(context);
    let response: Response;
    try { response = await fetcher(input, init); }
    catch (cause) { finish(init.signal?.aborted ? "cancelled" : "error"); throw cause; }
    if (!response.body) { finish(response.ok ? "completed" : "error", undefined, response.status); return response; }
    const collector = createUsageCollector(streamingHint || response.headers.get("content-type")?.includes("text/event-stream") === true);
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const next = await reader.read();
                if (next.done) { collector.finish(); finish(response.ok && !collector.failed() ? "completed" : "error", collector.usage(), response.status); controller.close(); return; }
                collector.push(next.value); controller.enqueue(next.value);
            } catch (cause) { finish(init.signal?.aborted ? "cancelled" : "error", collector.usage(), response.status); controller.error(cause); }
        },
        async cancel(reason) { finish("cancelled", collector.usage(), response.status); await reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
