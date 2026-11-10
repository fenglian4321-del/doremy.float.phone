'use client';
import { useEffect, useState } from 'react';
type Native = { getRememberedSiteLoginStatus?: () => string; forgetRememberedSiteLogin?: () => boolean };
const native = () =>
    typeof window === 'undefined' ? undefined : (window as unknown as { AndroidShell?: Native }).AndroidShell;
export function RememberedSiteLogin() {
    const [status, setStatus] = useState<'unsupported' | 'saved' | 'empty'>('unsupported'),
        [note, setNote] = useState('');
    function refresh() {
        try {
            const v = JSON.parse(native()?.getRememberedSiteLoginStatus?.() || '{}');
            setStatus(v.supported ? (v.saved ? 'saved' : 'empty') : 'unsupported');
        } catch {
            setStatus('unsupported');
        }
    }
    useEffect(() => {
        refresh();
    }, []);
    return (
        <section
            style={{ border: '1px solid var(--border, #ddd)', borderRadius: 16, padding: 14 }}
            aria-label="记住APK站点登录"
        >
            <strong style={{ fontSize: 14 }}>APK站点登录</strong>
            <p style={{ fontSize: 12, lineHeight: 1.8, opacity: 0.75 }}>
                {status === 'unsupported'
                    ? '当前浏览器或旧APK不提供本机加密登录。'
                    : status === 'saved'
                      ? '已在本机加密记住登录；再次打开本站时无需重复输入。'
                      : '尚未保存。下次原生登录框勾选“记住此设备登录”，成功后会在本机加密保存。'}
                密码不进入网页存储、聊天或导出备份。站点账号密码变更、凭据失效或清除应用数据后需要重新登录。
            </p>
            <button type="button" onClick={refresh}>
                刷新登录状态
            </button>
            {status === 'saved' && (
                <button
                    type="button"
                    onClick={() => {
                        const ok = native()?.forgetRememberedSiteLogin?.() === true;
                        setNote(
                            ok
                                ? '已删除保存凭据。当前已打开的站点会话可能继续有效；下次新的认证挑战需重新输入。'
                                : '未完成，请重试。',
                        );
                        refresh();
                    }}
                >
                    忘记保存的账号
                </button>
            )}
            {note && (
                <p role="status" style={{ fontSize: 12, lineHeight: 1.8 }}>
                    {note}
                </p>
            )}
        </section>
    );
}
