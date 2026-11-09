import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { normalizeTokenUsage as usage } from '../lib/token-usage.ts';
assert.equal(usage(null), undefined);
assert.equal(usage({usage: []}), undefined);
assert.equal(usage({}), undefined);
assert.equal(usage({usage: {prompt_tokens: -1}}), undefined);
assert.equal(usage({usage: {prompt_tokens: '12'}}), undefined);
const openai = usage({usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: {cached_tokens: 80}, completion_tokens_details: {reasoning_tokens: 10}}});
assert.equal(openai.total_tokens, 120);
assert.equal(openai.cached_tokens, 80);
assert.equal(openai.reasoning_tokens, 10);
assert.equal(usage({usageMetadata: {promptTokenCount: 100, cachedContentTokenCount: 60}}).cached_tokens, 60);
assert.equal(usage({usage: {prompt_tokens: 0, prompt_cache_hit_tokens: 0}}).cached_tokens, 0);
assert.equal(usage({usage: {input_tokens: 8, output_tokens: 2}}).total_tokens, undefined);

// Verify actual provider response parsing retains the new fields, not just the helper.
const context = vm.createContext({ console });
const adapter = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(
    new URL('../lib/llm-provider-adapter.ts', import.meta.url), 'utf8',
)), { context });
const fixtures = {
    './token-usage': { normalizeTokenUsage: usage },
    './api-helpers': Object.fromEntries([
        'buildChatCompletionsUrl', 'buildRequestHeaders', 'determineBaseUrl',
        'isNativeAnthropicApi', 'isNativeGoogleApi', 'stripHallucinatedTimestamps',
    ].map(name => [name, () => { throw new Error(`Unexpected API helper: ${name}`); }])),
    './generation-parameters': { resolveEnabledGenerationParameters() {} },
};
fixtures['./api-helpers'].stripHallucinatedTimestamps = text => text;
await adapter.link(specifier => {
    const values = fixtures[specifier];
    assert.ok(values, `Unstubbed dependency ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
});
await adapter.evaluate();
const parse = adapter.namespace.parseProviderResponse;
const parsed = parse('openai-compatible', { choices: [], usage: {
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 80 },
    completion_tokens_details: { reasoning_tokens: 10 },
} });
assert.equal(parsed.usage.cached_tokens, 80);
assert.equal(parsed.usage.reasoning_tokens, 10);
assert.equal(parsed.usage.total_tokens, 120);
assert.equal(parse('gemini', { usageMetadata: {
    promptTokenCount: 100, cachedContentTokenCount: 60, thoughtsTokenCount: 5,
} }).usage.cached_tokens, 60);
assert.equal(parse('openai-compatible', { choices: [] }).usage, undefined);
console.log('Token usage normalization and provider integration tests passed');
