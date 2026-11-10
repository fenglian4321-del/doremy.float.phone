export const INNER_MODULES = [
    'state',
    'body',
    'jars',
    'thoughts',
    'blackbox',
    'cabin',
    'core',
    'timeline',
] as const;
export type InnerModule = (typeof INNER_MODULES)[number];
export type InnerBinding = { characterId: string; coreHash: string; name: string };
export type InnerControls = {
    revision: number;
    generation: 'inherit' | 'paused';
    jarGeneration: 'inherit' | 'paused';
    binding: InnerBinding | null;
    cycleMinutes: number;
    toolsConfigured: boolean;
    modelConfigured: boolean;
    jarConfigured: boolean;
    privateText: boolean;
    shadow: boolean;
};
export type InnerDocument = {
    module: InnerModule;
    status: 'available' | 'disabled' | 'restricted';
    at: string;
    summary: string;
    metrics: { key: string; label: string; value: number; unit: string }[];
    records: {
        id: string;
        title: string;
        text: string;
        at?: string;
        meta?: string;
        locked?: boolean;
        from?: 'user' | 'ai';
        read?: boolean;
    }[];
    controls: InnerControls;
};
export type InnerAction =
    | { action: 'bind'; binding: InnerBinding; confirm: true }
    | {
          action: 'controls';
          generation: 'inherit' | 'paused';
          jarGeneration: 'inherit' | 'paused';
          confirm: true;
      }
    | { action: 'letter'; content: string; locked: boolean }
    | { action: 'letter_lock'; id: string; locked: boolean }
    | { action: 'letter_read'; id: string }
    | { action: 'body_offset'; hr: number; breath: number; minutes: number }
    | { action: 'satisfy'; drive: string }
    | { action: 'refill'; drive: string; confirm: true }
    | { action: 'anchor_add'; label: string; description: string; confirm: true }
    | { action: 'anchor_remove'; key: string; confirm: true };
