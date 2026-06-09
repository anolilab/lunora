// A backend-free CirrusClient stand-in for design iteration on the studio.
//
// The real worker can't always run locally (e.g. the Cloudflare Vite plugin
// fails to boot in some sandboxes), and the studio's look-and-feel work needs
// representative data in every panel. This mock answers the same admin RPC
// references the panels call (see `@cirrus/studio`'s `ADMIN_FUNCTIONS`) with
// fixed, plausible data — mirroring how the package's own tests render panels
// from a mock client, minus the vitest spies.
//
// Dev-only: imported solely by `main.mock.tsx`, never by the shipped studio.
import { ADMIN_FUNCTIONS } from "@cirrus/studio";
import type { CirrusClient } from "@cirrus/studio";

interface Ref {
    readonly __cirrusRef: string;
}

const TABLES = [
    { name: "messages", rowCount: 128 },
    { name: "users", rowCount: 42 },
    { name: "posts", rowCount: 17 },
    { name: "reactions", rowCount: 305 },
];

const PAGES: Record<string, { columns: string[]; rows: Record<string, unknown>[]; total: number }> = {
    messages: {
        columns: ["id", "author", "body", "createdAt"],
        rows: [
            { id: "msg_01H9", author: "ada", body: "Pushed the new shard router 🚀", createdAt: 1_749_300_120_000 },
            { id: "msg_01H8", author: "grace", body: "Reviewed — looks great, merging.", createdAt: 1_749_299_980_000 },
            { id: "msg_01H7", author: "lin", body: "Anyone seeing slow reads on us-east?", createdAt: 1_749_299_640_000 },
            { id: "msg_01H6", author: "ada", body: "Adding an index for that query.", createdAt: 1_749_299_100_000 },
            { id: "msg_01H5", author: "grace", body: "Deploy is green ✅", createdAt: 1_749_298_700_000 },
        ],
        total: 128,
    },
    posts: {
        columns: ["id", "title", "published", "views"],
        rows: [
            { id: "post_7", title: "Edge-native state with Cirrus", published: true, views: 1284 },
            { id: "post_6", title: "Sharding by tenant", published: true, views: 642 },
            { id: "post_5", title: "Realtime without the ceremony", published: false, views: 0 },
        ],
        total: 17,
    },
    reactions: { columns: ["id", "messageId", "emoji", "userId"], rows: [], total: 305 },
    users: {
        columns: ["id", "email", "name", "createdAt"],
        rows: [
            { id: "usr_ada", email: "ada@example.com", name: "Ada Lovelace", createdAt: 1_749_100_000_000 },
            { id: "usr_grace", email: "grace@example.com", name: "Grace Hopper", createdAt: 1_749_050_000_000 },
            { id: "usr_lin", email: "lin@example.com", name: "Lin Clark", createdAt: 1_749_000_000_000 },
        ],
        total: 42,
    },
};

const FUNCTIONS = [
    {
        calls: 1280,
        errors: 2,
        lastCalledAt: 1_749_300_120_000,
        lastErrorAt: null,
        lastErrorMessage: null,
        maxDurationMs: 41,
        path: "messages:list",
        totalDurationMs: 7100,
    },
    {
        calls: 642,
        errors: 0,
        lastCalledAt: 1_749_300_020_000,
        lastErrorAt: null,
        lastErrorMessage: null,
        maxDurationMs: 28,
        path: "messages:send",
        totalDurationMs: 3300,
    },
    {
        calls: 87,
        errors: 5,
        lastCalledAt: 1_749_299_900_000,
        lastErrorAt: 1_749_299_700_000,
        lastErrorMessage: "Rate limited",
        maxDurationMs: 120,
        path: "posts:publish",
        totalDurationMs: 2400,
    },
];

const now = 1_749_300_120_000;

const minuteBuckets = (n: number, base: number, jitter: number): { bucketMs: number; calls: number; errors: number; path: string }[] =>
    Array.from({ length: n }, (_, index) => ({
        bucketMs: now - (n - index) * 60_000,
        calls: Math.round(base + Math.sin(index / 2) * jitter + jitter),
        errors: index % 7 === 0 ? 1 : 0,
        path: "messages:list",
    }));

/** Fixed payload per admin reference; shared by `query` and `subscribe`. */
const dataFor = (reference: string, args: unknown): unknown => {
    const argument = (args ?? {}) as { table?: string };

    switch (reference) {
        case ADMIN_FUNCTIONS.listTables: {
            return TABLES;
        }
        case ADMIN_FUNCTIONS.readTablePage: {
            return PAGES[argument.table ?? "messages"] ?? { columns: [], rows: [], total: 0 };
        }
        case ADMIN_FUNCTIONS.migrationStatus: {
            return { migrations: [] };
        }
        case ADMIN_FUNCTIONS.getFunctionStats: {
            return { functions: FUNCTIONS, sinceMs: now - 3_600_000 };
        }
        case ADMIN_FUNCTIONS.getMetrics: {
            return {
                cache: { bytes: 1_048_576, entries: 312, evictions: 4, hits: 8421, misses: 311 },
                databaseSize: 4_194_304,
                errors: 7,
                functions: FUNCTIONS,
                history: minuteBuckets(30, 18, 6),
                requests: 2009,
                shard: "__root__",
                sinceMs: now - 3_600_000,
                uptimeMs: 5_400_000,
            };
        }
        case ADMIN_FUNCTIONS.getAuthMetrics: {
            return {
                attempts: 214,
                failureRate: 0.04,
                failures: 9,
                history: Array.from({ length: 30 }, (_, index) => ({
                    attempts: 6 + (index % 4),
                    bucketMs: now - (30 - index) * 60_000,
                    failures: index % 9 === 0 ? 1 : 0,
                })),
                sinceMs: now - 3_600_000,
            };
        }
        case ADMIN_FUNCTIONS.getLogs: {
            return {
                entries: [
                    { functionPath: "posts:publish", level: "error", message: "Rate limited (429) from upstream", timestamp: now - 4000 },
                    { functionPath: "messages:list", level: "info", message: "Served 128 rows in 12ms", timestamp: now - 9000 },
                    { functionPath: "messages:send", level: "warn", message: "Slow write: 28ms", timestamp: now - 15_000 },
                    { level: "debug", message: "Reactive cache warm (312 entries)", timestamp: now - 22_000 },
                ],
            };
        }
        case ADMIN_FUNCTIONS.getAuditLog: {
            return {
                entries: [
                    { detail: { userId: "usr_ada" }, id: "post_5", op: "writeRow", seq: 412, table: "posts", ts: now - 60_000 },
                    { detail: { userId: "usr_grace" }, op: "runMigration", seq: 411, ts: now - 240_000 },
                ],
            };
        }
        case ADMIN_FUNCTIONS.getRequestLog: {
            return {
                entries: [
                    {
                        durationMs: 12,
                        functionPath: "messages:list",
                        outcome: "ok",
                        seq: 9001,
                        subscriptionsReRun: 0,
                        tablesRead: ["messages"],
                        tablesWritten: [],
                        ts: now - 4000,
                    },
                    {
                        durationMs: 120,
                        errorMessage: "Rate limited",
                        functionPath: "posts:publish",
                        outcome: "error",
                        seq: 9000,
                        subscriptionsReRun: 0,
                        tablesRead: ["posts"],
                        tablesWritten: [],
                        ts: now - 9000,
                    },
                ],
            };
        }
        case ADMIN_FUNCTIONS.getSettings: {
            return {
                deploy: { deploymentId: "dev-local", environment: "development", versionTag: "v0.0.0", workerUrl: "http://localhost:5173" },
                settings: [
                    { kind: "var", name: "AUTH_URL", value: "http://localhost:5173" },
                    { kind: "secret", name: "AUTH_SECRET", value: "••••••••" },
                    { bindingType: "durable-object", kind: "binding", name: "SHARD_DO", value: null },
                    { bindingType: "r2", kind: "binding", name: "UPLOADS", value: null },
                ],
            };
        }
        case ADMIN_FUNCTIONS.getSecurityAudit: {
            // Representative of this mock's dev profile (see getSettings): a short
            // token, the WS gate open (info in dev), and the dev-mode request log.
            return {
                findings: [
                    { detail: { length: 8, min: 24 }, kind: "admin-token-weak", level: "warning" },
                    { kind: "dev-args-unredacted", level: "warning" },
                    { kind: "ws-gate-open", level: "info" },
                ],
            };
        }
        case ADMIN_FUNCTIONS.listTableIndexes: {
            return { indexes: [{ fields: ["createdAt"], name: "by_createdAt", type: "index" }] };
        }
        case ADMIN_FUNCTIONS.getPitrBookmark: {
            return { current: "0000003f-0000000a" };
        }
        default: {
            return { columns: [], entries: [], rows: [], total: 0 };
        }
    }
};

const noop = (): void => {};

/** A plain mock client cast to {@link CirrusClient}, for the dev harness only. */
export const createDevMockClient = (): CirrusClient =>
    ({
        action: async (): Promise<unknown> => ({}),
        cancelScheduledJob: async (): Promise<{ cancelled: boolean }> => ({ cancelled: true }),
        close: noop,
        connectionStatus: (): string => "connected",
        listAuthSessions: async (): Promise<unknown> => ({ rows: [], total: 0 }),
        listAuthUsers: async (): Promise<unknown> => ({
            rows: [
                { createdAt: 1_749_100_000_000, email: "ada@example.com", emailVerified: true, id: "usr_ada", image: null, name: "Ada Lovelace" },
                { createdAt: 1_749_050_000_000, email: "grace@example.com", emailVerified: true, id: "usr_grace", image: null, name: "Grace Hopper" },
                { createdAt: 1_749_000_000_000, email: "lin@example.com", emailVerified: false, id: "usr_lin", image: null, name: "Lin Clark" },
            ],
            total: 42,
        }),
        listFunctions: async (): Promise<unknown> => [
            { kind: "query", path: "messages:list" },
            { kind: "mutation", path: "messages:send" },
            { kind: "mutation", path: "posts:publish" },
            { kind: "action", path: "posts:syncToStripe" },
        ],
        listGlobalTables: async (): Promise<unknown> => [{ name: "feature_flags", rowCount: 12 }],
        listScheduledJobs: async (): Promise<unknown> => [
            { id: "job_1", name: "clear presence", runAt: now + 60_000 },
            { id: "job_2", name: "digest email", runAt: now + 3_600_000 },
        ],
        listStorageObjects: async (): Promise<unknown> => ({
            objects: [
                { key: "uploads/avatar-ada.png", size: 20_480, uploaded: now - 86_400_000 },
                { key: "uploads/cover.jpg", size: 153_600, uploaded: now - 172_800_000 },
            ],
        }),
        mutation: async (): Promise<unknown> => ({}),
        onConnectionStatus: (): (() => void) => noop,
        query: async (function_: Ref, args: unknown): Promise<unknown> => dataFor(function_.__cirrusRef, args),
        readGlobalTablePage: async (): Promise<unknown> => ({
            columns: ["key", "enabled", "rollout"],
            rows: [
                { enabled: true, key: "new-dashboard", rollout: 100 },
                { enabled: false, key: "ai-suggestions", rollout: 0 },
            ],
            total: 12,
        }),
        setAuthToken: noop,
        subscribe: (function_: Ref, args: unknown, callback: (value: unknown) => void): (() => void) => {
            // Emit once on the next tick so the panel paints with data, the same
            // shape its `query` path would return.
            queueMicrotask(() => callback(dataFor(function_.__cirrusRef, args)));

            return noop;
        },
        subscribeScheduledJobs: (callback: (jobs: unknown) => void): (() => void) => {
            queueMicrotask(() => callback([{ id: "job_1", name: "clear presence", runAt: now + 60_000 }]));

            return noop;
        },
    }) as unknown as CirrusClient;
