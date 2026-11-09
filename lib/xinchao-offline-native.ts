export type XinchaoOfflineStatus = { protocol: 'float-shell-xinchao-wake/v1'; location: 'android_device'; supported: boolean; enabled: boolean; notificationsGranted: boolean; status: string };
type Native = { getXinchaoOfflineWakeStatus(): string; setXinchaoOfflineWakeEnabled(enabled: boolean): string };
const native = () => typeof window === 'undefined' ? undefined : (window as unknown as { AndroidShell?: Partial<Native> }).AndroidShell;
function parse(raw: string): XinchaoOfflineStatus {
    const value = JSON.parse(raw);
    if (value?.protocol !== 'float-shell-xinchao-wake/v1' || value.location !== 'android_device' || typeof value.supported !== 'boolean' || typeof value.enabled !== 'boolean' || typeof value.notificationsGranted !== 'boolean' || typeof value.status !== 'string' || !/^[a-z_]{1,64}$/.test(value.status)) throw new Error('本机离线桥版本不匹配。');
    return { protocol: value.protocol, location: value.location, supported: value.supported, enabled: value.enabled, notificationsGranted: value.notificationsGranted, status: value.status };
}
export function readXinchaoOfflineStatus(): XinchaoOfflineStatus | null {
    const bridge = native();
    if (typeof bridge?.getXinchaoOfflineWakeStatus !== 'function' || typeof bridge.setXinchaoOfflineWakeEnabled !== 'function') return null;
    try { return parse(bridge.getXinchaoOfflineWakeStatus()); } catch { return null; }
}
export function setXinchaoOfflineEnabled(enabled: boolean): XinchaoOfflineStatus {
    const bridge = native(); if (!bridge?.setXinchaoOfflineWakeEnabled) throw new Error('当前浏览器或旧APK没有本机离线提醒能力。');
    const raw = bridge.setXinchaoOfflineWakeEnabled(enabled), value = parse(raw);
    if (JSON.parse(raw).ok !== true || value.enabled !== enabled) throw new Error(value.notificationsGranted ? '本机设置未确认，未改用其他推送渠道。' : '请先在系统设置中允许 Float 通知，再明确开启。');
    return value;
}
