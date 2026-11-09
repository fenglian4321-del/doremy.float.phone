import { estimateTokens } from './token-counter';
import type { ApiConfig } from './settings-types';
import type { LlmRequestPayload } from './llm-provider-adapter';

/** Conservative text estimate, not provider usage or a claim about image tokens. */
export function guardConsolidationBudget(request: LlmRequestPayload, config: ApiConfig) {
    const window = config.contextWindowTokens;
    if (!Number.isSafeInteger(window) || !window || window < 1024) throw new Error('当前模型上下文窗口未知，未发送整理请求。');
    const body = request.body;
    const generation = body.generationConfig as Record<string, unknown> | undefined;
    let reserve: number;
    if (request.providerKind === 'gemini') {
        const settings = generation ?? {}; body.generationConfig = settings;
        reserve = typeof settings.maxOutputTokens === 'number' ? settings.maxOutputTokens : 2048;
        settings.maxOutputTokens = reserve;
    } else {
        reserve = typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : typeof body.max_tokens === 'number' ? body.max_tokens : 2048;
        if (body.max_completion_tokens === undefined) body.max_tokens = reserve;
    }
    const input = estimateTokens(JSON.stringify(body));
    if (!Number.isSafeInteger(reserve) || reserve < 1 || input + reserve + 1024 > window) throw new Error(`本次请求估计输入 ${input} + 回复预留 ${reserve} + 余量1024，超过模型窗口 ${window}；未截断规则、最近对话或证据。请调整预算。`);
    return { input, reserve, window, tokenKind: 'estimate' as const };
}
