'use client';
import { useState } from 'react';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { loadMemoryConfig, saveMemoryConfig } from '@/lib/memory-storage';
import { SharedMemoryPanel } from './shared-memory-panel';
import styles from './memory-sky.module.css';
export function MemorySkyApp({ onClose }: { onClose: () => void }) {
    const [config, setConfig] = useState(loadMemoryConfig);
    return <main className={styles.app} aria-label="记忆星图App">
        <header className={styles.header}><button type="button" onClick={onClose} aria-label="关闭记忆星图"><ArrowLeft size={18} /></button><span><Sparkles size={14} />记忆星图</span><small>OUR CONSTELLATION</small></header>
        <SharedMemoryPanel initiallyOpen source={config.memorySource ?? 'local'}
            onSourceChange={source => { const fresh = { ...loadMemoryConfig(), memorySource: source }; saveMemoryConfig(fresh); setConfig(fresh); }}
            recallMode={config.automaticRecallEnabled === false ? 'off' : config.sharedRecallMode ?? 'ombre'}
            onRecallModeChange={mode => { const fresh = { ...loadMemoryConfig(), automaticRecallEnabled: mode !== 'off', ...(mode !== 'off' ? { sharedRecallMode: mode } : {}) }; saveMemoryConfig(fresh); setConfig(fresh); }} />
    </main>;
}
