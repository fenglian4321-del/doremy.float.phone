// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryConfig, loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { loadSharedMemoryEntries, noteSharedMemoryRecall } from "./shared-memory-client";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    if (config.automaticRecallEnabled === false || loadMemoryConfig().automaticRecallEnabled === false) return [];
    if (!currentContext.trim()) return [];
    if (loadMemoryConfig().memorySource === "shared") {
        const entries = await loadSharedMemoryEntries(characterId, currentContext, loadMemoryConfig().sharedRecallMode ?? "ombre");
        const result = fillByBudget(entries.filter(entry => entry.type === "long_term"), config.longTermTokenBudget);
        void noteSharedMemoryRecall(result).catch(() => undefined); // Activation bookkeeping must not block successfully read facts.
        return result;
    }
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (loadMemoryConfig().automaticRecallEnabled === false) return [];
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return fillByBudget(longTermEntries, budget);
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    if (config.automaticRecallEnabled === false || loadMemoryConfig().automaticRecallEnabled === false) return [];
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    const result = fillByBudget(sorted, config.coreMemoryTokenBudget);
    if (loadMemoryConfig().memorySource === "shared") void noteSharedMemoryRecall(result).catch(() => undefined);
    return result;
}

/** Pick whole entries in order, skipping candidates that exceed the remaining budget. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    if (loadMemoryConfig().automaticRecallEnabled === false) return [];
    const result: MemoryEntry[] = [];
    const seenIds = new Set<string>();
    const seenContents = new Set<string>();
    let used = 0;
    for (const entry of entries) {
        const content = entry.content.trim();
        if (!content || seenIds.has(entry.id) || seenContents.has(content)) continue;
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) continue;
        result.push(entry);
        seenIds.add(entry.id); seenContents.add(content);
        used += tokens;
    }
    return result;
}
