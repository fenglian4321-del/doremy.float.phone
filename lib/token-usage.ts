export type TokenUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
    cache_creation_tokens?: number;
};

// Missing usage stays unknown. Preserve provider totals without adding cache/reasoning fields.
export function normalizeTokenUsage(data: unknown): TokenUsage | undefined {
    const record = (value: unknown): Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown> : {};
    const d = record(data);
    const candidates = Array.isArray(d.candidates) ? d.candidates : [];
    const u = record(d.usage ?? record(d.message).usage ?? record(d.response).usage ?? record(d.output).usage ?? d.usageMetadata ?? record(candidates[0]).usageMetadata);
    const valid = (...values: unknown[]): number | undefined => values.find(
        (v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
    ) as number | undefined;
    const input = valid(u.input_tokens);
    const cacheRead = valid(u.cache_read_input_tokens);
    const cacheWrite = valid(u.cache_creation_input_tokens);
    // Anthropic input_tokens excludes both cache reads and cache creation.
    const anthropicInput = input !== undefined && (cacheRead !== undefined || cacheWrite !== undefined)
        ? input + (cacheRead ?? 0) + (cacheWrite ?? 0) : input;
    const result: TokenUsage = {
        prompt_tokens: valid(u.prompt_tokens, anthropicInput, u.promptTokenCount),
        completion_tokens: valid(u.completion_tokens, u.output_tokens, u.candidatesTokenCount),
        total_tokens: valid(u.total_tokens, u.totalTokenCount),
        cached_tokens: valid(record(u.prompt_tokens_details).cached_tokens, record(u.input_tokens_details).cached_tokens, u.prompt_cache_hit_tokens, u.cachedContentTokenCount, cacheRead),
        reasoning_tokens: valid(record(u.completion_tokens_details).reasoning_tokens, record(u.output_tokens_details).reasoning_tokens, u.thoughtsTokenCount),
        cache_creation_tokens: cacheWrite,
    };
    return Object.values(result).some(v => v !== undefined) ? result : undefined;
}
