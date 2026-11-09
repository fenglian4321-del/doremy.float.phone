'use client';
import { useEffect, useState } from 'react';
import type { ApiConfig } from '@/lib/settings-types';
import { loadUsageRates, saveUsageRate, removeUsageRate, type UsageRate } from '@/lib/usage-cost';
import styles from './shared-memory.module.css';
export function UsageRateEditor({ configs, onChange }: { configs: ApiConfig[]; onChange: () => void }) {
    const [configId, setConfigId] = useState(''), [currency, setCurrency] = useState<'CNY' | 'USD'>('CNY');
    const [fields, setFields] = useState({ input: '', output: '', cacheRead: '', cacheWrite: '' }), [sameCache, setSameCache] = useState(true), [note, setNote] = useState('');
    const selected = configs.find(config => config.id === configId);
    const selectedId = selected?.id, selectedProvider = selected?.provider, selectedModel = selected?.defaultModel;
    useEffect(() => {
        const row = loadUsageRates().find(row => row.configId === selectedId && row.provider === selectedProvider && row.model === selectedModel);
        setFields({ input: row ? String(row.input) : '', output: row ? String(row.output) : '', cacheRead: row ? String(row.cacheRead) : '', cacheWrite: row ? String(row.cacheWrite) : '' });
        setSameCache(!row || (row.input === row.cacheRead && row.input === row.cacheWrite)); setCurrency(row?.currency || 'CNY'); setNote('');
    }, [selectedId, selectedProvider, selectedModel]);
    const identity = selected ? { configId: selected.id, provider: selected.provider, model: selected.defaultModel } : null;
    const save = () => {
        if (!identity) return;
        try {
            const required = sameCache ? ['input', 'output'] as const : ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
            if (required.some(key => !fields[key].trim())) throw new Error('请填写单价；免费可明确填0，空白表示未知。');
            const rate: UsageRate = { ...identity, currency, input: Number(fields.input), output: Number(fields.output), cacheRead: Number(sameCache ? fields.input : fields.cacheRead), cacheWrite: Number(sameCache ? fields.input : fields.cacheWrite) };
            saveUsageRate(rate); onChange(); setNote('已按当前手填费率回算；以后修改也会更新历史估算。');
        } catch (error) { setNote(error instanceof Error ? error.message : '费率未保存。'); }
    };
    return <details className={styles.fold}><summary>费用估算 · 手动单价</summary>
        <p className={styles.muted}>不内置价格。按你填写的每百万 Token 单价回算当前筛选记录，币种分别合计；这是估算，不是供应商账单。换中转或套餐后请更新费率。缺少用量或必需的缓存细项时保持未知。</p>
        <select className={styles.usageSelect} aria-label="费用配置" value={configId} onChange={event => setConfigId(event.target.value)}><option value="">选择已有API配置</option>{configs.map(config => <option key={config.id} value={config.id}>{config.name || config.provider} · {config.defaultModel}</option>)}</select>
        {selected && <><select className={styles.usageSelect} aria-label="估算币种" value={currency} onChange={event => setCurrency(event.target.value as 'CNY' | 'USD')}><option value="CNY">CNY</option><option value="USD">USD</option></select>
            <div className={styles.row}>{(['input', 'output'] as const).map(key => <label className={styles.muted} key={key}>{key === 'input' ? '普通输入' : '输出'} / 百万 Token<input className={styles.input} aria-label={key === 'input' ? '普通输入单价' : '输出单价'} type="number" min="0" max="1000000" step="any" value={fields[key]} onChange={event => setFields(old => ({ ...old, [key]: event.target.value }))} /></label>)}</div>
            <label className={styles.muted}><input type="checkbox" checked={sameCache} onChange={event => setSameCache(event.target.checked)} />缓存读取和创建统一按普通输入单价估算</label>
            {!sameCache && <div className={styles.row}>{(['cacheRead', 'cacheWrite'] as const).map(key => <label className={styles.muted} key={key}>{key === 'cacheRead' ? '缓存读取' : '缓存创建'} / 百万 Token<input className={styles.input} aria-label={key === 'cacheRead' ? '缓存读取单价' : '缓存创建单价'} type="number" min="0" max="1000000" step="any" value={fields[key]} onChange={event => setFields(old => ({ ...old, [key]: event.target.value }))} /></label>)}</div>}
            <div className={styles.row}><button className={styles.button} type="button" onClick={save}>保存估算费率</button><button className={styles.quiet} type="button" onClick={() => { if (identity) { removeUsageRate(identity); onChange(); setNote('费率已清除；未填写的费用保持未知。'); } }}>清除此费率</button></div></>}
        {note && <p className={styles.muted} role="status">{note}</p>}
    </details>;
}
