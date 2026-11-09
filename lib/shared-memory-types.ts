/** Remote Ombre data; these are view models, never a second writable memory store. */
export type SharedMemorySummary = {
    id: string;
    name: string;
    preview: string;
    type?: string;
    tags: string[];
    domains: string[];
    createdAt?: string;
    lastActiveAt?: string;
    dontSurface?: boolean;
};

export type SharedMemoryDetail = {
    id: string;
    content: string;
    metadata: Record<string, unknown>;
};

export type SharedMemoryReviewDetail = SharedMemoryDetail & { revision: string; provenance?: Record<string, unknown>; modifiedAt?: string };
export type SharedMemoryManagedEntry = SharedMemoryDetail & { revision: string; state: "active" | "archived" | "deleted" };
export type SharedMemoryManagementIntent = { targetId: string; operation: "archive" | "delete" | "restore"; clientKey: string; baseRevision: string };
export type SharedMemoryManagementReceipt = { id: string; targetId: string; operation: "archive" | "delete" | "restore"; state: "applying" | "completed" | "conflict" };
export type SharedMemoryImportReceipt = { targetId: string; batchId: string; state: "created" | "existing"; owned: boolean };
export type SharedMemoryImportBatch = { id: string; at: string; total: number; created: number; undone: number; pending: number };
export type SharedMemoryImportRollback = { targetId: string | null; state: "kept_existing" | "applying" | "rolled_back" | "needs_review"; code?: string };
export type SharedMemoryPolicy = { paused: boolean; reviewRequired: boolean; version: number };
export type SharedMemoryCandidate = {
    id: string;
    kind: "create" | "edit";
    targetId: string;
    content: string;
    source: Record<string, unknown>;
    before: SharedMemoryDetail | null;
    state: "pending" | "applying" | "conflict" | "approved" | "rejected";
    version: number;
    createdAt: string;
    updatedAt: string;
};
export type SharedMemoryHistory = {
    id: string;
    targetId: string;
    before: SharedMemoryDetail | null;
    after: SharedMemoryDetail;
    afterRevision: string;
    source: Record<string, unknown>;
    at: string;
};
