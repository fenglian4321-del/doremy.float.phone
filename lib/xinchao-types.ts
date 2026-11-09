/** Browser-safe projection; never includes the upstream token, raw state or engine configuration. */
export type XinchaoSnapshot = {
    version: '4.3.0'; revision: number; fetchedAt: string;
    consciousness: string; lastSettledAt: string | null;
    drives: { key: string; label: string; value: number }[];
    now: { available: boolean; text: string; reason: string | null; generatedAt: string; revision: number };
};
