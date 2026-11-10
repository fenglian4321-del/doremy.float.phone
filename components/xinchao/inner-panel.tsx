'use client';
import { useEffect, useRef, useState } from 'react';
import {
    fetchInnerModule,
    mutateInner,
    innerPending,
    checkInnerReceipt,
    acknowledgeInner,
} from '@/lib/xinchao-inner-client';
import {
    innerPreferences,
    setInnerPreferences,
    characterCoreHash,
    type InnerPreferences,
} from '@/lib/xinchao-core';
import { loadCharacters } from '@/lib/character-storage';
import { setXinchaoChatSettings } from '@/lib/xinchao-chat';
import { setXinchaoFeedbackSettings } from '@/lib/xinchao-feedback';
import { cachedXinchaoProactiveSettings, configureXinchaoProactive } from '@/lib/xinchao-proactive-client';
import type { InnerAction, InnerDocument, InnerModule } from '@/lib/xinchao-inner-types';
import styles from './xinchao.module.css';
const modules: { id: InnerModule; name: string; subtitle: string }[] = [
    { id: 'state', name: '潮汐', subtitle: '情绪 · 完整驱力 · 清醒' },
    { id: 'body', name: '身体与脉', subtitle: '模拟心率与呼吸' },
    { id: 'jars', name: '念头罐', subtitle: '已经备好的短句' },
    { id: 'thoughts', name: '思绪池', subtitle: '闪念、执念与梦' },
    { id: 'blackbox', name: '黑匣子', subtitle: '角色自己的工具入口' },
    { id: 'cabin', name: '小屋来信', subtitle: '信件与锁' },
    { id: 'core', name: '人格与锚点', subtitle: '固定核心 · 动态自评' },
    { id: 'timeline', name: '时间线', subtitle: '同一份状态事件记录' },
];
type Choice = { id: string; characterId: string; label: string };
export function XinchaoInnerPanel({ enabled, choices }: { enabled: boolean; choices: Choice[] }) {
    const [module, setModule] = useState<InnerModule>('state'),
        [doc, setDoc] = useState<InnerDocument | null>(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [note, setNote] = useState('选择栏目读取已有数据；查看不生成内容。'),
        [preferences, setPreferences] = useState<InnerPreferences>({
            binding: null,
            tools: false,
            bodyInChat: false,
        });
    const [selection, setSelection] = useState(''),
        [letter, setLetter] = useState(''),
        [locked, setLocked] = useState(true),
        [drive, setDrive] = useState(''),
        [offset, setOffset] = useState({ hr: 0, breath: 0, minutes: 15 }),
        [anchor, setAnchor] = useState({ label: '', description: '' }),
        [confirm, setConfirm] = useState<InnerAction | null>(null);
    const controller = useRef<AbortController | null>(null),
        generation = useRef(0);
    useEffect(() => {
        const update = () => setPreferences(innerPreferences());
        update();
        window.addEventListener('xinchao-core-updated', update);
        return () => window.removeEventListener('xinchao-core-updated', update);
    }, []);
    useEffect(() => {
        generation.current++;
        controller.current?.abort();
        setDoc(null);
        setError('');
        setBusy(false);
        return () => {
            generation.current++;
            controller.current?.abort();
        };
    }, [enabled]);
    async function read(next: InnerModule = module) {
        if (!enabled) return;
        controller.current?.abort();
        const c = new AbortController();
        controller.current = c;
        const epoch = ++generation.current;
        setBusy(true);
        setError('');
        setDoc(null);
        setModule(next);
        try {
            const value = await fetchInnerModule(next, c.signal);
            if (epoch === generation.current) {
                setDoc(value);
                setNote(
                    value.status === 'disabled'
                        ? '接口已接入，服务端此模块尚未启用。'
                        : value.status === 'restricted'
                          ? '已按原访问契约连接；本页不读取受限正文。'
                          : '已读取同一心潮服务的本次数据。',
                );
            }
        } catch (e) {
            if (!c.signal.aborted && epoch === generation.current)
                setError(e instanceof Error ? e.message : '读取未完成。');
        } finally {
            if (epoch === generation.current) {
                setBusy(false);
                controller.current = null;
            }
        }
    }
    async function act(input: InnerAction) {
        if (!doc || busy) return;
        const c = new AbortController();
        controller.current = c;
        const epoch = ++generation.current;
        setBusy(true);
        setError('');
        setConfirm(null);
        try {
            await mutateInner(doc.controls.revision, input, c.signal);
            if (c.signal.aborted || epoch !== generation.current) return;
            if (input.action === 'letter') setLetter('');
            let bindingNotice = '';
            if (input.action === 'bind') {
                setInnerPreferences({ binding: input.binding, tools: false, bodyInChat: false });
                const chosen = choices.find(
                    (c) => c.id === selection && c.characterId === input.binding.characterId,
                );
                setXinchaoChatSettings({
                    enabled: false,
                    sessionId: chosen?.id || '',
                    characterId: input.binding.characterId,
                });
                setXinchaoFeedbackSettings({
                    enabled: false,
                    sessionId: chosen?.id || '',
                    characterId: input.binding.characterId,
                });
                try {
                    const prior = cachedXinchaoProactiveSettings();
                    await configureXinchaoProactive({
                        ...prior,
                        enabled: false,
                        autoReply: false,
                        offlineNotify: false,
                        sessionId: chosen?.id || '',
                        characterId: input.binding.characterId,
                    });
                } catch {
                    bindingNotice =
                        '固定角色已保存。主动服务未确认接收新的绑定设置，请在主动消息设置核对原绑定和通知。';
                }
            }
            setNote(
                bindingNotice ||
                    (input.action === 'refill'
                        ? '续罐请求已完成，请查看同一罐内数量；本次使用了服务端模型。'
                        : '操作已有服务端回执。'),
            );
            const value = await fetchInnerModule(module, c.signal);
            if (!c.signal.aborted && epoch === generation.current) setDoc(value);
        } catch (e) {
            if (!c.signal.aborted) setError(e instanceof Error ? e.message : '结果未确认，请核对原回执。');
        } finally {
            if (epoch === generation.current) {
                setBusy(false);
                controller.current = null;
            }
        }
    }
    const pending = innerPending(),
        updatePreferences = (next: Partial<InnerPreferences>) =>
            setInnerPreferences({ ...preferences, ...next });
    return (
        <section className={styles.inner} aria-label="心潮内室">
            <div className={styles.sectionTitle}>
                <div>
                    <h2>心潮内室</h2>
                </div>
            </div>
            <nav className={styles.moduleGrid} aria-label="心潮栏目">
                {modules.map((m) => (
                    <button
                        type="button"
                        key={m.id}
                        aria-pressed={module === m.id && !!doc}
                        disabled={!enabled || busy}
                        onClick={() => void read(m.id)}
                    >
                        <strong>{m.name}</strong>
                        <small>{m.subtitle}</small>
                    </button>
                ))}
            </nav>
            {!enabled && (
                <p className={styles.note}>
                    先打开上方“允许 Float 查看”。各栏目按需读取；不会自动补罐、发信、启动后台生成或写记忆。
                </p>
            )}
            {error && (
                <p role="alert" className={styles.error}>
                    {error}
                </p>
            )}
            {pending && (
                <div className={styles.card}>
                    <p className={styles.note}>待核对：{pending.action}。旧操作不会自动重做。</p>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            void checkInnerReceipt()
                                .then((v) =>
                                    setNote(`原回执：${v?.state || '没有记录'}。请同时核对实际结果。`),
                                )
                                .catch((e) => setError(e.message))
                        }
                    >
                        查询原回执
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                            acknowledgeInner();
                            setNote('已人工核对；仅清除本机等待标记，原生服务回执保留。');
                        }}
                    >
                        已核对，清除等待标记
                    </button>
                </div>
            )}
            {doc && (
                <article className={styles.card} aria-label={modules.find((m) => m.id === module)?.name}>
                    <div className={styles.sectionTitle}>
                        <h2>{modules.find((m) => m.id === module)?.name}</h2>
                        <button type="button" disabled={busy} onClick={() => void read()}>
                            刷新本栏目
                        </button>
                    </div>
                    <p className={styles.note}>{doc.summary}</p>
                    {doc.metrics.length > 0 && (
                        <div className={styles.innerMetrics}>
                            {doc.metrics.map((m) => (
                                <div key={m.key}>
                                    <span>{m.label}</span>
                                    <strong>
                                        {m.unit === '比例' ? `${Math.round(m.value * 100)}%` : m.value}
                                    </strong>
                                    {m.unit === '比例' && (
                                        <meter min={0} max={1} value={m.value} aria-label={m.label} />
                                    )}
                                    <small>{m.unit === '比例' ? '引擎状态' : m.unit}</small>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className={styles.innerRecords}>
                        {doc.records.map((r) => (
                            <div key={r.id}>
                                <div className={styles.sectionTitle}>
                                    <strong>{r.title}</strong>
                                    {r.at && <time>{new Date(r.at).toLocaleString('zh-CN')}</time>}
                                </div>
                                {r.text && <p>{r.text}</p>}
                                {r.meta && <small>{r.meta}</small>}
                                {module === 'cabin' && r.from === 'user' && (
                                    <button
                                        type="button"
                                        disabled={busy || !!pending}
                                        onClick={() =>
                                            void act({ action: 'letter_lock', id: r.id, locked: !r.locked })
                                        }
                                    >
                                        {r.locked ? '允许角色阅读（开锁）' : '锁住，不再提供给角色'}
                                    </button>
                                )}
                                {module === 'cabin' && r.from === 'ai' && !r.read && (
                                    <button
                                        type="button"
                                        disabled={busy || !!pending}
                                        onClick={() => void act({ action: 'letter_read', id: r.id })}
                                    >
                                        标记已读
                                    </button>
                                )}
                                {module === 'core' && r.id !== 'identity' && (
                                    <button
                                        type="button"
                                        disabled={busy || !!pending}
                                        onClick={() =>
                                            setConfirm({ action: 'anchor_remove', key: r.id, confirm: true })
                                        }
                                    >
                                        移除此行为锚点
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                    {!doc.records.length && !doc.metrics.length && doc.status === 'available' && (
                        <p className={styles.empty}>这份真实记录当前为空。</p>
                    )}
                    {module === 'core' && (
                        <>
                            <div className={styles.coreCard}>
                                <h3>{doc.controls.binding?.name || '尚未固定角色'}</h3>
                                <p className={styles.note}>
                                    固定角色保留在原角色库，人设不会被心情、月度分数或工具结果覆盖。重新绑定不会迁移或删除旧角色、记忆和聊天；本机聊天与互动反馈会暂停，主动服务配置将单独核对。
                                </p>
                                <label className={styles.binding}>
                                    选择固定角色的生活私聊
                                    <select
                                        value={selection}
                                        onChange={(e) => setSelection(e.target.value)}
                                        aria-label="固定角色的生活私聊"
                                    >
                                        <option value="">由你明确选择</option>
                                        {choices.map((c) => (
                                            <option value={c.id} key={c.id}>
                                                {c.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <button
                                    type="button"
                                    disabled={busy || !!pending || !selection}
                                    onClick={() => {
                                        const chosen = choices.find((c) => c.id === selection),
                                            char = loadCharacters().find((c) => c.id === chosen?.characterId);
                                        if (char)
                                            void characterCoreHash(char).then((coreHash) =>
                                                setConfirm({
                                                    action: 'bind',
                                                    binding: {
                                                        characterId: char.id,
                                                        name: char.name,
                                                        coreHash,
                                                    },
                                                    confirm: true,
                                                }),
                                            );
                                    }}
                                >
                                    核对并固定此角色
                                </button>
                            </div>
                            <label className={styles.binding}>
                                新增行为锚点
                                <input
                                    aria-label="行为锚点名称"
                                    value={anchor.label}
                                    maxLength={40}
                                    onChange={(e) => setAnchor({ ...anchor, label: e.target.value })}
                                />
                                <textarea
                                    aria-label="行为锚点说明"
                                    value={anchor.description}
                                    maxLength={300}
                                    onChange={(e) => setAnchor({ ...anchor, description: e.target.value })}
                                />
                            </label>
                            <button
                                type="button"
                                disabled={busy || !!pending || !anchor.label.trim()}
                                onClick={() => setConfirm({ action: 'anchor_add', ...anchor, confirm: true })}
                            >
                                核对后保存锚点
                            </button>
                            <p className={styles.note}>
                                这里修改同一心潮人格文件的锚点，最多7条；不修改14维分数或Float角色卡。它与“锚定记忆桶”不同。
                            </p>
                        </>
                    )}
                    {module === 'cabin' && (
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                void act({ action: 'letter', content: letter, locked });
                            }}
                        >
                            <label className={styles.binding}>
                                留一封信
                                <textarea
                                    aria-label="小屋信件正文"
                                    value={letter}
                                    maxLength={8000}
                                    onChange={(e) => setLetter(e.target.value)}
                                    placeholder="只放你想留在这间小屋里的话。"
                                />
                            </label>
                            <label className={styles.future}>
                                <span>先上锁，暂不交给角色</span>
                                <input
                                    type="checkbox"
                                    checked={locked}
                                    onChange={(e) => setLocked(e.target.checked)}
                                />
                            </label>
                            <button type="submit" disabled={busy || !!pending || !letter.trim()}>
                                放进同一小屋
                            </button>
                            <p className={styles.note}>
                                不复制到长期记忆，不自动请求回复。解锁只允许角色之后按需使用收件箱工具；已经读过的文字无法撤回。
                            </p>
                        </form>
                    )}
                    {module === 'body' && doc.status === 'available' && (
                        <>
                            <div className={styles.offsetInputs}>
                                {(['hr', 'breath', 'minutes'] as const).map((k) => (
                                    <label key={k}>
                                        {k === 'hr'
                                            ? '模拟心率偏移'
                                            : k === 'breath'
                                              ? '模拟呼吸偏移'
                                              : '有效分钟'}
                                        <input
                                            type="number"
                                            aria-label={k}
                                            value={offset[k]}
                                            min={k === 'hr' ? -40 : k === 'breath' ? -10 : 1}
                                            max={k === 'hr' ? 80 : k === 'breath' ? 20 : 180}
                                            onChange={(e) =>
                                                setOffset({ ...offset, [k]: Number(e.target.value) })
                                            }
                                        />
                                    </label>
                                ))}
                            </div>
                            <button
                                type="button"
                                disabled={busy || !!pending}
                                onClick={() => void act({ action: 'body_offset', ...offset })}
                            >
                                施加临时模拟偏移
                            </button>
                        </>
                    )}
                    {(module === 'state' || module === 'jars') && (
                        <>
                            <label className={styles.binding}>
                                选择驱力
                                <select
                                    aria-label="选择驱力"
                                    value={drive}
                                    onChange={(e) => setDrive(e.target.value)}
                                >
                                    <option value="">请选择</option>
                                    {(module === 'jars'
                                        ? doc.metrics
                                        : doc.metrics.filter(
                                              (m) => !['valence', 'arousal', 'fatigue'].includes(m.key),
                                          )
                                    ).map((m) => (
                                        <option key={m.key} value={m.key}>
                                            {m.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {module === 'state' ? (
                                <button
                                    type="button"
                                    disabled={busy || !!pending || !drive}
                                    onClick={() => void act({ action: 'satisfy', drive })}
                                >
                                    记录这股驱力已得到满足
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    disabled={
                                        busy ||
                                        !!pending ||
                                        !drive ||
                                        !doc.controls.jarConfigured ||
                                        doc.controls.generation === 'paused' ||
                                        doc.controls.jarGeneration === 'paused'
                                    }
                                    onClick={() => setConfirm({ action: 'refill', drive, confirm: true })}
                                >
                                    使用服务端模型续这一罐
                                </button>
                            )}
                        </>
                    )}
                    <p className={styles.timestamp}>
                        来自同一心潮4.3.0 · {new Date(doc.at).toLocaleString('zh-CN')}
                    </p>
                </article>
            )}
            {doc && (
                <details className={styles.card}>
                    <summary>联动与费用控制</summary>
                    <p className={styles.note}>
                        服务端已有结算周期：每 {doc.controls.cycleMinutes}{' '}
                        分钟。恢复沿用原配置，不额外创建调度。后台梦境、闪念、罐内短句可能使用服务端模型；每次补罐通常一次，兼容重试可能两次。停用阻止后续请求，已经发出的请求可能完成。
                    </p>
                    <p className={styles.note}>
                        服务端模型：{doc.controls.modelConfigured ? '已配置' : '未配置'} · 念头罐：
                        {doc.controls.jarConfigured ? '已配置' : '未启用/未配置'} · 模式：
                        {doc.controls.shadow ? 'shadow' : 'active'} · 私密正文：
                        {doc.controls.privateText ? '服务端允许' : '服务端未允许'}
                    </p>
                    <button
                        type="button"
                        disabled={busy || !!pending}
                        onClick={() =>
                            setConfirm({
                                action: 'controls',
                                generation: doc.controls.generation === 'paused' ? 'inherit' : 'paused',
                                jarGeneration: doc.controls.jarGeneration,
                                confirm: true,
                            })
                        }
                    >
                        {doc.controls.generation === 'paused'
                            ? '恢复服务原有后台生成配置'
                            : '暂停服务端后续模型生成'}
                    </button>
                    <button
                        type="button"
                        disabled={busy || !!pending}
                        onClick={() =>
                            setConfirm({
                                action: 'controls',
                                generation: doc.controls.generation,
                                jarGeneration: doc.controls.jarGeneration === 'paused' ? 'inherit' : 'paused',
                                confirm: true,
                            })
                        }
                    >
                        {doc.controls.jarGeneration === 'paused' ? '恢复原有自动续罐配置' : '暂停自动续罐'}
                    </button>
                    <label className={styles.future}>
                        <span>
                            角色按需使用内室工具
                            <small>
                                {doc.controls.toolsConfigured
                                    ? '服务端MCP已启用，仅固定角色可调用'
                                    : '服务端MCP尚未启用'}
                            </small>
                        </span>
                        <input
                            type="checkbox"
                            checked={preferences.tools}
                            disabled={
                                !preferences.tools &&
                                (!doc.controls.toolsConfigured ||
                                    !preferences.binding ||
                                    doc.controls.binding?.coreHash !== preferences.binding.coreHash)
                            }
                            onChange={(e) => updatePreferences({ tools: e.target.checked })}
                        />
                    </label>
                    <label className={styles.future}>
                        <span>
                            聊天“此刻”包含模拟身体<small>仍需另外开启下方聊天联动</small>
                        </span>
                        <input
                            type="checkbox"
                            checked={preferences.bodyInChat}
                            disabled={!preferences.binding}
                            onChange={(e) => updatePreferences({ bodyInChat: e.target.checked })}
                        />
                    </label>
                    <p className={styles.note}>
                        查看、聊天使用状态、互动反馈、服务端后台生成、主动回复/离线通知分别控制。黑匣子/思绪/念头不自动入长期记忆。工作区和私人任务文件不自动读取内室；记忆星图仍连接原Ombre库。栖所、阅读和原私人记录保留，不因名称相近删除。
                    </p>
                </details>
            )}
            {confirm && (
                <div className={styles.confirm} role="dialog" aria-modal="true" aria-label="确认心潮操作">
                    <div className={styles.card}>
                        <h2>核对这次操作</h2>
                        <p>
                            {confirm.action === 'bind'
                                ? `将${confirm.binding.name}固定为此心潮实例的角色；暂停各项联动，不删除旧数据。`
                                : confirm.action === 'refill'
                                  ? '本次向服务端配置的模型发起续罐请求，可能计费，失败不会自动重试。'
                                  : confirm.action.startsWith('anchor_')
                                    ? '修改同一心潮持久行为锚点，不修改角色卡；请确认这是你认定的底线变更。'
                                    : '修改既有服务的生成设置，不新建任务；恢复可能重新产生模型费用。'}
                        </p>
                        <button type="button" onClick={() => setConfirm(null)}>
                            取消
                        </button>
                        <button type="button" disabled={busy || !!pending} onClick={() => void act(confirm)}>
                            确认这次操作
                        </button>
                    </div>
                </div>
            )}
            <p className={styles.note} role="status">
                {busy ? '正在读取或核对回执…' : note}
            </p>
        </section>
    );
}
