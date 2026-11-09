// DTOs only: no network, credentials, model, storage or runtime startup.
export type XinchaoProactiveSettings = {
    version: number; epoch: number; enabled: boolean; sessionId: string; characterId: string;
    autoReply: boolean; offlineNotify: boolean; cooldownMinutes: number;
    quiet: { enabled: boolean; startMinute: number; endMinute: number; timeZone: string };
};
export type XinchaoInboxItem = {
    deliveryId: string; reason: string; state: 'receiving' | 'pending' | 'claimed' | 'complete' | 'ignored' | 'expired' | 'unavailable';
    receivedAt: number; expiresAt: number; policyVersion: number; ack: 'none' | 'pending' | 'confirmed' | 'uncertain'; replyId?: string;
};
export const emptyXinchaoProactiveSettings = (): XinchaoProactiveSettings => ({ version: 0, epoch: 0, enabled: false, sessionId: '', characterId: '', autoReply: false, offlineNotify: false, cooldownMinutes: 30, quiet: { enabled: true, startMinute: 1380, endMinute: 480, timeZone: 'UTC' } });
export const xinchaoProactiveId = (value: unknown): value is string => typeof value === 'string' && /^[^\x00-\x20\x7f]{1,160}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export function validXinchaoProactiveSettings(value: unknown): value is XinchaoProactiveSettings {
    if (!exact(value, ['version', 'epoch', 'enabled', 'sessionId', 'characterId', 'autoReply', 'offlineNotify', 'cooldownMinutes', 'quiet'])
        || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 0
        || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || typeof value.enabled !== 'boolean' || typeof value.autoReply !== 'boolean' || typeof value.offlineNotify !== 'boolean'
        || !Number.isSafeInteger(value.cooldownMinutes) || Number(value.cooldownMinutes) < 5 || Number(value.cooldownMinutes) > 1440
        || typeof value.sessionId !== 'string' || typeof value.characterId !== 'string' || (value.sessionId !== '' && !xinchaoProactiveId(value.sessionId)) || (value.characterId !== '' && !xinchaoProactiveId(value.characterId)) || (value.enabled && (!xinchaoProactiveId(value.sessionId) || !xinchaoProactiveId(value.characterId)))
        || (!value.enabled && (value.autoReply || value.offlineNotify))
        || !exact(value.quiet, ['enabled', 'startMinute', 'endMinute', 'timeZone'])) return false;
    const quiet = value.quiet;
    if (typeof quiet.enabled !== 'boolean' || !Number.isSafeInteger(quiet.startMinute) || Number(quiet.startMinute) < 0 || Number(quiet.startMinute) > 1439 || !Number.isSafeInteger(quiet.endMinute) || Number(quiet.endMinute) < 0 || Number(quiet.endMinute) > 1439 || quiet.startMinute === quiet.endMinute || typeof quiet.timeZone !== 'string' || quiet.timeZone.length > 80) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: quiet.timeZone }); return true; } catch { return false; }
}
export function xinchaoProactiveQuiet(settings: XinchaoProactiveSettings, at = Date.now()) {
    if (!settings.quiet.enabled) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: settings.quiet.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at));
    const minute = Number(parts.find(part => part.type === 'hour')?.value) % 24 * 60 + Number(parts.find(part => part.type === 'minute')?.value);
    const { startMinute: start, endMinute: end } = settings.quiet;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
