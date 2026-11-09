'use client';
import { useState } from 'react';
import { WorkspacePanel } from '@/components/memory/workspace-panel';
import type { SpaceKind } from '@/lib/workspace-client';
export function WorkbenchApp({ onClose }: { onClose: () => void }) {
    const [kind, setKind] = useState<SpaceKind>('work');
    return <WorkspacePanel key={kind} kind={kind} onBack={onClose} onKindChange={setKind} />;
}
