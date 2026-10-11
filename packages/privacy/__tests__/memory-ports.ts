/**
 * In-memory ports for the tests. They keep the state a test needs to read back:
 * request rows and events, stored files, and the rows each table still holds.
 */
import type { Dataset } from "../src/dataset";
import type { RequestRecord, RequestStore } from "../src/requests";
import type { DataPort, StorePort } from "../src/run";

export const memoryRequests = (): RequestStore & { events: string[]; rows: Map<string, RequestRecord> } => {
    const rows = new Map<string, RequestRecord>();
    const events: string[] = [];

    return {
        addEvent: async (requestId, _at, kind) => {
            events.push(`${requestId}:${kind}`);
        },
        events,
        findOpen: async (subjectId, type) =>
            [...rows.values()].find((row) => row.subjectId === subjectId && row.type === type && row.status !== "completed" && row.status !== "cancelled"),
        get: async (id) => rows.get(id),
        insert: async (record) => {
            rows.set(record.id, record);
        },
        listOpen: async () => [...rows.values()].filter((row) => row.status !== "completed" && row.status !== "cancelled"),
        rows,
        update: async (id, patch) => {
            const existing = rows.get(id);

            if (existing !== undefined) {
                rows.set(id, { ...existing, ...patch });
            }
        },
    };
};

export const memoryFiles = (): StorePort & { files: Map<string, Uint8Array | string> } => {
    const files = new Map<string, Uint8Array | string>();

    return {
        files,
        put: async (requestId, file) => {
            files.set(`${requestId}/${file.name}`, file.data);

            return `${requestId}/${file.name}`;
        },
        read: async (requestId, name) => {
            const value = files.get(`${requestId}/${name}`);

            return typeof value === "string" ? value : undefined;
        },
        signedUrl: async (key, ttlSeconds) => `https://files.test/${key}?ttl=${String(ttlSeconds)}`,
    };
};

/**
 * A data port over per-table row counts. Each erase batch clears up to 100 rows
 * from every table, as a real port would, and `remaining` reports what is left.
 */
export const memoryData = (initial: Readonly<Record<string, number>>): DataPort & { rows: Record<string, number> } => {
    const rows: Record<string, number> = { ...initial };

    return {
        collect: async (dataset: Dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, [{ id: `${table}-1` }]])),
        eraseBatch: async (dataset: Dataset) => {
            let hasMore = false;

            for (const table of dataset.tableNames) {
                rows[table] = Math.max(0, (rows[table] ?? 0) - 100);
                hasMore = hasMore || (rows[table] ?? 0) > 0;
            }

            return { hasMore };
        },
        remaining: async (dataset: Dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, rows[table] ?? 0])),
        rows,
    };
};
