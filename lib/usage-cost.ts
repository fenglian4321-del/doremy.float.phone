import { kvGet, kvSet, registerKvMigration } from './kv-db';
import type { UsageLedgerEntry } from './usage-ledger';
export type UsageRate = { configId: string; provider: string; model: string; currency: 'CNY' | 'USD'; input: number; output: number; cacheRead: number; cacheWrite: number };
const KEY = 'float_private_usage_rates_v1'; registerKvMigration(KEY);
const price = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f]|https?:\/\/|bearer\s|\bsk-/i.test(value);
function valid(value: unknown): value is UsageRate {
    if (!value || typeof value !== 'object') return false;
    const row = value as UsageRate;
    return text(row.configId) && text(row.provider) && text(row.model) && ['CNY', 'USD'].includes(row.currency) && [row.input, row.output, row.cacheRead, row.cacheWrite].every(price);
}
const clean = (row: UsageRate): UsageRate => ({ configId: row.configId, provider: row.provider, model: row.model, currency: row.currency, input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite });
const same = (a: Pick<UsageRate, 'configId' | 'provider' | 'model'>, b: Pick<UsageLedgerEntry, 'configId' | 'provider' | 'model'>) => a.configId === b.configId && a.provider === b.provider && a.model === b.model;
export function loadUsageRates(): UsageRate[] {
    try { const rows: unknown = JSON.parse(kvGet(KEY) || '[]'); return Array.isArray(rows) ? rows.filter(valid).slice(-256).map(clean) : []; } catch { return []; }
}
export function saveUsageRate(rate: UsageRate) {
    if (!valid(rate)) throw new Error('请输入有效币种和每百万 Token 单价（0–1000000）。');
    const rows = loadUsageRates().filter(row => !same(row, rate)); rows.push(clean(rate)); kvSet(KEY, JSON.stringify(rows.slice(-256)));
}
export function removeUsageRate(rate: Pick<UsageRate, 'configId' | 'provider' | 'model'>) { kvSet(KEY, JSON.stringify(loadUsageRates().filter(row => !same(row, rate)))); }
/** Recalculate using the user's CURRENT manual rate. Never a supplier invoice. */
export function estimateUsageCost(row: UsageLedgerEntry, rates: UsageRate[]): { currency: 'CNY' | 'USD'; amount: number } | undefined {
    if (row.source === 'tool' || row.status === 'pending') return;
    const rate = rates.find(rate => same(rate, row)); if (!rate || !valid(rate)) return;
    const usage = row.usage, input = usage?.prompt_tokens, output = usage?.completion_tokens;
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (!count(input) || !count(output)) return;
    const read = usage?.cached_tokens, write = usage?.cache_creation_tokens;
    if ((read !== undefined && !count(read)) || (write !== undefined && !count(write)) || (read ?? 0) + (write ?? 0) > input) return;
    if ((rate.cacheRead !== rate.input && read === undefined) || (rate.cacheWrite !== rate.input && write === undefined)) return;
    const amount = (input * rate.input + output * rate.output + (read ?? 0) * (rate.cacheRead - rate.input) + (write ?? 0) * (rate.cacheWrite - rate.input)) / 1000000;
    return Number.isFinite(amount) && amount >= 0 ? { currency: rate.currency, amount } : undefined;
}
export function summarizeUsageCost(rows: UsageLedgerEntry[], rates: UsageRate[]) {
    const totals: Partial<Record<'CNY' | 'USD', number>> = {}; let priced = 0, unknown = 0;
    for (const row of rows) { if (row.source === 'tool') continue; const estimate = estimateUsageCost(row, rates); if (!estimate) { unknown++; continue; } priced++; totals[estimate.currency] = (totals[estimate.currency] ?? 0) + estimate.amount; }
    return { totals, priced, unknown };
}
