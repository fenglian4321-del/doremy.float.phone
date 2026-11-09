import type { ApiConfig } from "./settings-types";

export type ProviderBalance = { at: string; available: boolean; balances: { currency: "CNY" | "USD"; total: string; granted: string; toppedUp: string }[] };
export function supportsBalance(config: Pick<ApiConfig, "provider" | "baseUrl">): boolean {
    if (config.provider !== "DeepSeek") return false;
    if (!config.baseUrl?.trim()) return true;
    try {
        const url = new URL(config.baseUrl.trim());
        return url.origin === "https://api.deepseek.com" && !url.username && !url.password && !url.search && !url.hash && ["", "/", "/v1", "/v1/"].includes(url.pathname);
    } catch { return false; }
}
/** A relay's key is never sent to an assumed upstream. Unsupported balances stay unknown. */
export async function queryProviderBalance(config: ApiConfig, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ProviderBalance> {
    if (!supportsBalance(config)) throw new Error("此配置尚无已核实的余额接口，请在对应供应商控制台查看。");
    if (!config.apiKey) throw new Error("此配置尚未填写密钥。");
    let response: Response;
    try { response = await fetcher("https://api.deepseek.com/user/balance", {
        method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` }, credentials: "omit", cache: "no-store", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    }); } catch { throw new Error("余额查询未成功，可能是网络、跨域限制或请求取消；未取得余额。"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`余额接口返回 ${response.status}，未取得余额。`); }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new Error("余额返回格式无效，未取得余额。"); }
    const value = raw as { is_available?: unknown; balance_infos?: unknown } | null;
    const money = (v: unknown): v is string => typeof v === "string" && /^-?\d{1,18}(?:\.\d{1,8})?$/.test(v);
    if (!value || typeof value.is_available !== "boolean" || !Array.isArray(value.balance_infos) || value.balance_infos.length > 4 || !value.balance_infos.length) throw new Error("余额返回格式无效，未取得余额。");
    const balances: ProviderBalance["balances"] = [];
    for (const item of value.balance_infos) {
        if (!item || !["CNY", "USD"].includes(item.currency) || !money(item.total_balance) || !money(item.granted_balance) || !money(item.topped_up_balance)) throw new Error("余额返回格式无效，未取得余额。");
        balances.push({ currency: item.currency, total: item.total_balance, granted: item.granted_balance, toppedUp: item.topped_up_balance });
    }
    return { at: new Date().toISOString(), available: value.is_available, balances };
}
