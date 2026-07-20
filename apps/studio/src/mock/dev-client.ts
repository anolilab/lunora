// A backend-free LunoraClient stand-in for design iteration on the studio.
//
// The real worker can't always run locally (e.g. the Cloudflare Vite plugin
// fails to boot in some sandboxes), and the studio's look-and-feel work needs
// representative data in every panel. This mock answers the same admin RPC
// references the panels call (see `@lunora/studio`'s `ADMIN_FUNCTIONS`) with
// fixed, plausible data — mirroring how the package's own tests render panels
// from a mock client, minus the vitest spies.
//
// Dev-only: imported solely by `main.mock.tsx`, never by the shipped studio.
//
// Every method is `async` to match @lunora/studio's Promise-returning
// `LunoraClient` surface, yet returns fixed data synchronously — so a blanket
// require-await disable is intentional here, not a smell.
/* eslint-disable @typescript-eslint/require-await -- mock implements an async client interface with synchronous fixtures */
import type { LunoraClient } from "@lunora/studio";
import { ADMIN_FUNCTIONS } from "@lunora/studio";

interface Ref {
    readonly __lunoraRef: string;
}

/** Image-extension test for the signed-URL mock; module-scoped so it isn't recompiled per call. */
const IMAGE_KEY_RE = /\.(?:gif|jpe?g|png|webp)$/iu;

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
            { id: "post_7", title: "Edge-native state with Lunora", published: true, views: 1284 },
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
        lastErrorAt: undefined,
        lastErrorMessage: undefined,
        maxDurationMs: 41,
        path: "messages:list",
        totalDurationMs: 7100,
    },
    {
        calls: 642,
        errors: 0,
        lastCalledAt: 1_749_300_020_000,
        lastErrorAt: undefined,
        lastErrorMessage: undefined,
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

// Folded `ctx.trace` waterfalls for the Traces panel — the shape `@lunora/do`'s
// `foldTraces` emits: each span already flattened with a `depth` (indent) and an
// `offsetMs` (bar start relative to the trace), newest trace first. Covers the
// states the panel renders: deep nesting, structured attributes, a fast
// single-child trace, and an errored child that flips the trace's status badge.
const TRACES = [
    {
        durationMs: 320,
        functionPath: "orders:checkout",
        ok: true,
        rootName: "orders:checkout",
        shardKey: "tenant-acme",
        spans: [
            { depth: 0, durationMs: 320, name: "orders:checkout", offsetMs: 0, ok: true, parentSpanId: "", spanId: "c0" },
            { attributes: { itemCount: 3 }, depth: 1, durationMs: 20, name: "cart.load", offsetMs: 2, ok: true, parentSpanId: "c0", spanId: "c1" },
            {
                attributes: { provider: "stripe" },
                depth: 1,
                durationMs: 210,
                name: "payment.authorize",
                offsetMs: 25,
                ok: true,
                parentSpanId: "c0",
                spanId: "c2",
            },
            {
                attributes: { method: "POST", url: "api.stripe.com/v1/charges" },
                depth: 2,
                durationMs: 200,
                name: "http.post",
                offsetMs: 28,
                ok: true,
                parentSpanId: "c2",
                spanId: "c3",
            },
            { depth: 1, durationMs: 50, name: "inventory.reserve", offsetMs: 240, ok: true, parentSpanId: "c0", spanId: "c4" },
            { attributes: { table: "inventory" }, depth: 2, durationMs: 40, name: "db.update", offsetMs: 245, ok: true, parentSpanId: "c4", spanId: "c5" },
        ],
        startTs: now - 4000,
        traceId: "trace-checkout",
    },
    {
        durationMs: 220,
        functionPath: "messages:send",
        ok: true,
        rootName: "messages:send",
        shardKey: "room-general",
        spans: [
            { depth: 0, durationMs: 220, name: "messages:send", offsetMs: 0, ok: true, parentSpanId: "", spanId: "s0" },
            { depth: 1, durationMs: 8, name: "auth.check", offsetMs: 2, ok: true, parentSpanId: "s0", spanId: "s1" },
            { attributes: { table: "messages" }, depth: 1, durationMs: 40, name: "db.insert", offsetMs: 12, ok: true, parentSpanId: "s0", spanId: "s2" },
            { depth: 1, durationMs: 6, name: "cache.set", offsetMs: 55, ok: true, parentSpanId: "s0", spanId: "s3" },
            { attributes: { subscribers: 12 }, depth: 1, durationMs: 150, name: "fanout.publish", offsetMs: 64, ok: true, parentSpanId: "s0", spanId: "s4" },
            { depth: 2, durationMs: 140, name: "ws.send", offsetMs: 66, ok: true, parentSpanId: "s4", spanId: "s5" },
        ],
        startTs: now - 9000,
        traceId: "trace-send",
    },
    {
        durationMs: 180,
        functionPath: "posts:publish",
        ok: false,
        rootName: "posts:publish",
        shardKey: "tenant-acme",
        spans: [
            { depth: 0, durationMs: 180, name: "posts:publish", offsetMs: 0, ok: true, parentSpanId: "", spanId: "e0" },
            { depth: 1, durationMs: 5, name: "validate", offsetMs: 3, ok: true, parentSpanId: "e0", spanId: "e1" },
            {
                attributes: { amount: 4999, currency: "usd" },
                depth: 1,
                durationMs: 165,
                error: { message: "card_declined: Your card was declined.", type: "StripeError" },
                name: "stripe.charge",
                offsetMs: 10,
                ok: false,
                parentSpanId: "e0",
                spanId: "e2",
            },
        ],
        startTs: now - 15_000,
        traceId: "trace-publish",
    },
    {
        durationMs: 12,
        functionPath: "messages:list",
        ok: true,
        rootName: "messages:list",
        spans: [
            { depth: 0, durationMs: 12, name: "messages:list", offsetMs: 0, ok: true, parentSpanId: "", spanId: "l0" },
            { attributes: { rows: 128 }, depth: 1, durationMs: 9, name: "db.query", offsetMs: 1, ok: true, parentSpanId: "l0", spanId: "l1" },
        ],
        startTs: now - 22_000,
        traceId: "trace-list",
    },
];

// Aggregated `ctx.metrics.*` series for the Metrics page's Instruments table —
// the shape `@lunora/do`'s `MetricBuffer` fold emits: one running summary per
// (name, kind, dimensions). Covers each instrument kind and the with/without
// dimensions cases so the panel's counter-total / gauge-reading / histogram-mean
// projections and the dimension column both render.
const METRIC_SERIES = [
    {
        count: 642,
        firstTs: now - 3_600_000,
        functionPath: "orders:checkout",
        kind: "counter",
        last: 1,
        lastTs: now - 4000,
        max: 1,
        min: 1,
        name: "orders.placed",
        sum: 642,
    },
    {
        attributes: { route: "/api/messages" },
        count: 2009,
        firstTs: now - 3_600_000,
        functionPath: "messages:list",
        kind: "counter",
        last: 1,
        lastTs: now - 2000,
        max: 1,
        min: 1,
        name: "http.requests",
        sum: 2009,
    },
    {
        attributes: { route: "/api/posts" },
        count: 87,
        firstTs: now - 3_600_000,
        functionPath: "posts:publish",
        kind: "counter",
        last: 1,
        lastTs: now - 15_000,
        max: 1,
        min: 1,
        name: "http.requests",
        sum: 87,
    },
    {
        count: 340,
        firstTs: now - 3_600_000,
        functionPath: "orders:checkout",
        kind: "gauge",
        last: 3,
        lastTs: now - 4000,
        max: 9,
        min: 0,
        name: "cart.items",
        sum: 1190,
    },
    {
        count: 128,
        firstTs: now - 3_600_000,
        functionPath: "queue:drain",
        kind: "gauge",
        last: 12,
        lastTs: now - 6000,
        max: 45,
        min: 0,
        name: "queue.depth",
        sum: 2304,
    },
    {
        count: 642,
        firstTs: now - 3_600_000,
        functionPath: "orders:checkout",
        kind: "histogram",
        last: 128,
        lastTs: now - 4000,
        max: 812,
        min: 41,
        name: "checkout.ms",
        sum: 118_400,
    },
    {
        attributes: { table: "messages" },
        count: 1280,
        firstTs: now - 3_600_000,
        functionPath: "messages:list",
        kind: "histogram",
        last: 9,
        lastTs: now - 2000,
        max: 88,
        min: 3,
        name: "db.query.ms",
        sum: 15_360,
    },
];

const minuteBuckets = (n: number, base: number, jitter: number): { bucketMs: number; calls: number; errors: number; path: string }[] =>
    Array.from({ length: n }, (_, index) => {
        return {
            bucketMs: now - (n - index) * 60_000,
            calls: Math.round(base + Math.sin(index / 2) * jitter + jitter),
            errors: index % 7 === 0 ? 1 : 0,
            path: "messages:list",
        };
    });

/** Fixed payload per admin reference; shared by `query` and `subscribe`. */
const dataFor = (reference: string, args: unknown): unknown => {
    const argument = (args ?? {}) as { table?: string };

    switch (reference) {
        case ADMIN_FUNCTIONS.getAuditLog: {
            return {
                entries: [
                    { detail: { userId: "usr_ada" }, id: "post_5", op: "writeRow", seq: 412, table: "posts", ts: now - 60_000 },
                    { detail: { userId: "usr_grace" }, op: "runMigration", seq: 411, ts: now - 240_000 },
                ],
            };
        }
        case ADMIN_FUNCTIONS.getAuthMetrics: {
            return {
                attempts: 214,
                failureRate: 0.04,
                failures: 9,
                history: Array.from({ length: 30 }, (_, index) => {
                    return {
                        attempts: 6 + (index % 4),
                        bucketMs: now - (30 - index) * 60_000,
                        failures: index % 9 === 0 ? 1 : 0,
                    };
                }),
                sinceMs: now - 3_600_000,
            };
        }
        case ADMIN_FUNCTIONS.getFunctionStats: {
            return { functions: FUNCTIONS, sinceMs: now - 3_600_000 };
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
        case ADMIN_FUNCTIONS.getMetricSeries: {
            return { series: METRIC_SERIES };
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
        case ADMIN_FUNCTIONS.getPitrBookmark: {
            return { current: "0000003f-0000000a" };
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
        case ADMIN_FUNCTIONS.getSettings: {
            return {
                deploy: { deploymentId: "dev-local", environment: "development", versionTag: "v0.0.0", workerUrl: "http://localhost:5173" },
                settings: [
                    { kind: "var", name: "AUTH_URL", value: "http://localhost:5173" },
                    { kind: "secret", name: "AUTH_SECRET", value: "••••••••" },
                    { bindingType: "durable-object", kind: "binding", name: "SHARD_DO", value: undefined },
                    { bindingType: "r2", kind: "binding", name: "UPLOADS", value: undefined },
                ],
            };
        }
        case ADMIN_FUNCTIONS.getTraces: {
            // `total` exceeds the returned count so the panel's "showing N of M"
            // truncation notice renders — the mock demonstrates the affordance even
            // though it seeds only a handful of representative waterfalls.
            return { total: 63, traces: TRACES };
        }
        case ADMIN_FUNCTIONS.listSubscriptions: {
            return {
                connections: [
                    {
                        admin: false,
                        id: 0,
                        subscriptions: [
                            { args: { room: "general" }, functionPath: "messages:list", table: "messages" },
                            { args: { limit: 50 }, functionPath: "presence:list", table: "presence" },
                        ],
                    },
                    {
                        admin: false,
                        id: 1,
                        subscriptions: [{ args: { since: now - 60_000 }, functionPath: "feed:recent", table: "posts" }],
                    },
                    { admin: true, id: 2, subscriptions: [{ functionPath: "__lunora_admin__:getMetrics" }] },
                ],
                totalConnections: 3,
                totalSubscriptions: 4,
            };
        }
        case ADMIN_FUNCTIONS.listTableIndexes: {
            return { indexes: [{ fields: ["createdAt"], name: "by_createdAt", type: "index" }] };
        }
        case ADMIN_FUNCTIONS.listTables: {
            return TABLES;
        }
        case ADMIN_FUNCTIONS.listWorkflows: {
            return {
                workflows: [
                    { binding: "WORKFLOW_ORDER_PIPELINE", className: "OrderPipelineWorkflow", exportName: "orderPipeline", name: "order-pipeline" },
                    { binding: "WORKFLOW_WELCOME_EMAIL", className: "WelcomeEmailWorkflow", exportName: "welcomeEmail", name: "welcome-email" },
                ],
            };
        }
        case ADMIN_FUNCTIONS.maskPolicies: {
            // Fixture mask coverage so the data browser's "Mask sensitive columns"
            // toggle + header chips light up for the `users` table in the dev harness.
            return {
                columns: [
                    { column: "email", strategy: "redact", table: "users" },
                    { column: "name", strategy: "hash", table: "users" },
                ],
            };
        }
        case ADMIN_FUNCTIONS.migrationStatus: {
            return { migrations: [] };
        }
        case ADMIN_FUNCTIONS.readTablePage: {
            const page = PAGES[argument.table ?? "messages"] ?? { columns: [], rows: [], total: 0 };
            const { orderBy } = (args ?? {}) as { orderBy?: { column: string; direction: "asc" | "desc" } };

            if (orderBy === undefined) {
                return page;
            }

            // Apply the server-side sort so the mock reflects header-click ordering.
            const rows = page.rows.toSorted((first, second) => {
                const a = first[orderBy.column];
                const b = second[orderBy.column];
                const cmp = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));

                return orderBy.direction === "desc" ? -cmp : cmp;
            });

            return { ...page, rows };
        }
        case ADMIN_FUNCTIONS.runSql: {
            return {
                columns: ["author", "messages", "reactions"],
                rowCount: 3,
                rows: [
                    { author: "ada", messages: 42, reactions: 128 },
                    { author: "grace", messages: 31, reactions: 96 },
                    { author: "lin", messages: 18, reactions: 54 },
                ],
                truncated: false,
            };
        }
        case ADMIN_FUNCTIONS.studioFeatures: {
            // The mock dev harness exercises every panel, so report every optional
            // feature enabled — the studio then shows all nav pages.
            return { mail: true, payments: true, scheduler: true, storage: true, vectors: true, workflows: true };
        }
        default: {
            return { columns: [], entries: [], rows: [], total: 0 };
        }
    }
};

const noop = (): void => {};

/** A plain mock client cast to {@link LunoraClient}, for the dev harness only. */
const createDevMockClient = (): LunoraClient =>
    ({
        action: async (): Promise<unknown> => {
            return {};
        },
        banAuthUser: async (input: { userId: string }): Promise<unknown> => {
            return { banned: true, id: input.userId };
        },
        cancelScheduledJob: async (): Promise<{ cancelled: boolean }> => {
            return { cancelled: true };
        },
        close: noop,
        connectionStatus: (): string => "connected",
        createAuthUser: async (input: { email: string; name: string; role?: string }): Promise<unknown> => {
            return {
                createdAt: now,
                email: input.email,
                emailVerified: false,
                id: "usr_new",
                name: input.name,
                role: input.role ?? "user",
            };
        },
        impersonateAuthUser: async (input: { userId: string }): Promise<unknown> => {
            return {
                expiresAt: now + 3_600_000,
                token: `mock-impersonation-token-for-${input.userId}`,
                user: { id: input.userId },
            };
        },
        listAuthSessions: async (): Promise<unknown> => {
            return {
                rows: [
                    {
                        createdAt: now - 3_600_000,
                        expiresAt: now + 86_400_000,
                        id: "ses_1",
                        ipAddress: "127.0.0.1",
                        userAgent: "Mozilla/5.0",
                        userId: "usr_ada",
                    },
                ],
                total: 1,
            };
        },
        listAuthUsers: async (): Promise<unknown> => {
            return {
                rows: [
                    {
                        banned: false,
                        createdAt: 1_749_100_000_000,
                        email: "ada@example.com",
                        emailVerified: true,
                        id: "usr_ada",
                        image: undefined,
                        name: "Ada Lovelace",
                        role: "admin",
                    },
                    {
                        banned: false,
                        createdAt: 1_749_050_000_000,
                        email: "grace@example.com",
                        emailVerified: true,
                        id: "usr_grace",
                        image: undefined,
                        name: "Grace Hopper",
                        role: "user",
                    },
                    {
                        banned: true,
                        banReason: "spam",
                        createdAt: 1_749_000_000_000,
                        email: "lin@example.com",
                        emailVerified: false,
                        id: "usr_lin",
                        image: undefined,
                        name: "Lin Clark",
                        role: "user",
                    },
                ],
                total: 42,
            };
        },
        fetchOpenApi: async (): Promise<unknown> => {
            return {
                info: { title: "Lunora API (mock)", version: "0.0.0" },
                openapi: "3.1.0",
                paths: {
                    "/_lunora/rpc#messages:list": {
                        post: {
                            operationId: "messages:list",
                            responses: { default: { description: "RPC error." } },
                            summary: "query messages:list",
                            tags: ["messages"],
                        },
                    },
                    "/_lunora/rpc#messages:send": {
                        post: {
                            operationId: "messages:send",
                            responses: { default: { description: "RPC error." } },
                            summary: "mutation messages:send",
                            tags: ["messages"],
                        },
                    },
                    "/_lunora/rpc#posts:publish": {
                        post: {
                            operationId: "posts:publish",
                            responses: { default: { description: "RPC error." } },
                            summary: "mutation posts:publish",
                            tags: ["posts"],
                        },
                    },
                },
                tags: [{ name: "messages" }, { name: "posts" }],
            };
        },
        fetchOpenRpc: async (): Promise<unknown> => {
            return {
                info: { title: "Lunora RPC (mock)", version: "0.0.0" },
                methods: [
                    {
                        name: "messages:list",
                        params: [
                            {
                                name: "args",
                                schema: { properties: { channelId: { type: "string" }, limit: { type: "number" } }, required: ["channelId"], type: "object" },
                            },
                        ],
                        result: { name: "result", schema: {} },
                        "x-lunora-function-kind": "query",
                        "x-tags": [{ name: "messages" }],
                    },
                    {
                        name: "messages:send",
                        params: [{ name: "args", schema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" } }],
                        result: { name: "result", schema: {} },
                        "x-lunora-function-kind": "mutation",
                        "x-tags": [{ name: "messages" }],
                    },
                    {
                        name: "posts:publish",
                        params: [{ name: "args", schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" } }],
                        result: { name: "result", schema: {} },
                        "x-lunora-function-kind": "mutation",
                        "x-tags": [{ name: "posts" }],
                    },
                ],
                openrpc: "1.3.2",
            };
        },
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
        listStorageObjects: async (options: { prefix?: string }): Promise<unknown> => {
            // A small nested bucket so the studio's folder navigation has something to
            // walk; content-types + a `tag` so thumbnails and metadata sort demo.
            // Filtered by prefix to mimic R2's prefix listing.
            const all = [
                {
                    customMetadata: { tag: "profile" },
                    httpMetadata: { contentType: "image/png" },
                    key: "uploads/avatar-ada.png",
                    size: 20_480,
                    uploaded: now - 86_400_000,
                },
                {
                    customMetadata: { tag: "marketing" },
                    httpMetadata: { contentType: "image/jpeg" },
                    key: "uploads/cover.jpg",
                    size: 153_600,
                    uploaded: now - 172_800_000,
                },
                { httpMetadata: { contentType: "text/csv" }, key: "exports/2026/report.csv", size: 8192, uploaded: now - 3_600_000 },
                { httpMetadata: { contentType: "application/pdf" }, key: "exports/2026/summary.pdf", size: 51_200, uploaded: now - 7_200_000 },
                { httpMetadata: { contentType: "text/plain" }, key: "readme.txt", size: 512, uploaded: now - 600_000 },
            ];

            return { objects: all.filter((object) => object.key.startsWith(options.prefix ?? "")) };
        },
        deleteStorageObject: async (key: string): Promise<unknown> => {
            return { deleted: true, key };
        },
        // Real placeholder images for image keys (so thumbnails render); a fake URL otherwise.
        signedStorageUrl: async (key: string): Promise<string> =>
            IMAGE_KEY_RE.test(key) ? `https://picsum.photos/seed/${encodeURIComponent(key)}/320` : `https://mock.cdn.example/${key}?sig=dev`,
        uploadStorageObject: async (options: { key: string }): Promise<unknown> => {
            return { etag: "dev-etag", key: options.key };
        },
        mutation: async (): Promise<unknown> => {
            return {};
        },
        onConnectionStatus: (): (() => void) => noop,
        query: async (function_: Ref, args: unknown): Promise<unknown> => dataFor(function_.__lunoraRef, args),
        readGlobalTablePage: async (): Promise<unknown> => {
            return {
                columns: ["key", "enabled", "rollout"],
                rows: [
                    { enabled: true, key: "new-dashboard", rollout: 100 },
                    { enabled: false, key: "ai-suggestions", rollout: 0 },
                ],
                total: 12,
            };
        },
        facetGlobalColumn: async (options: { column: string }): Promise<unknown> => {
            const byColumn: Record<string, { count: number; value: unknown }[]> = {
                enabled: [
                    { count: 7, value: true },
                    { count: 5, value: false },
                ],
                rollout: [
                    { count: 5, value: 0 },
                    { count: 4, value: 100 },
                    { count: 3, value: 50 },
                ],
            };

            return { truncated: false, values: byColumn[options.column] ?? [] };
        },
        cancelAuthOrgInvitation: async (): Promise<void> => {},
        deleteAuthPasskey: async (): Promise<void> => {},
        disableAuthTwoFactor: async (): Promise<void> => {},
        getAuthCapabilities: async (): Promise<unknown> => {
            return { accounts: true, admin: true, organization: true, passkey: true, twoFactor: true };
        },
        listAuthAccounts: async (): Promise<unknown> => [
            { accountId: "ada@example.com", createdAt: 1_749_100_000_000, id: "acc_cred", providerId: "credential", userId: "usr_ada" },
            { accountId: "12345", createdAt: 1_749_100_000_000, id: "acc_gh", providerId: "github", userId: "usr_ada" },
        ],
        listAuthOrganizations: async (): Promise<unknown> => {
            return {
                rows: [{ createdAt: 1_749_000_000_000, id: "org_acme", name: "Acme Inc", slug: "acme" }],
                total: 1,
            };
        },
        listAuthOrgInvitations: async (): Promise<unknown> => {
            return {
                rows: [{ email: "new@example.com", id: "inv_1", organizationId: "org_acme", role: "member", status: "pending" }],
                total: 1,
            };
        },
        listAuthOrgMembers: async (): Promise<unknown> => {
            return {
                rows: [{ createdAt: 1_749_000_000_000, id: "mem_1", organizationId: "org_acme", role: "owner", userId: "usr_ada" }],
                total: 1,
            };
        },
        listAuthPasskeys: async (): Promise<unknown> => [
            { createdAt: 1_749_100_000_000, deviceType: "singleDevice", id: "pk_1", name: "MacBook", userId: "usr_ada" },
        ],
        removeAuthOrgMember: async (): Promise<void> => {},
        removeAuthUser: async (): Promise<void> => {},
        revokeAuthSession: async (): Promise<void> => {},
        revokeAuthUserSessions: async (): Promise<void> => {},
        setAuthToken: noop,
        setAuthUserPassword: async (): Promise<void> => {},
        setAuthUserRole: async (input: { role: string; userId: string }): Promise<unknown> => {
            return { id: input.userId, role: input.role };
        },
        unbanAuthUser: async (input: { userId: string }): Promise<unknown> => {
            return { banned: false, id: input.userId };
        },
        unlinkAuthAccount: async (): Promise<void> => {},
        updateAuthUser: async (input: { userId: string }): Promise<unknown> => {
            return { id: input.userId };
        },
        subscribe: (function_: Ref, args: unknown, callback: (value: unknown) => void): (() => void) => {
            // Emit once on the next tick so the panel paints with data, the same
            // shape its `query` path would return.
            queueMicrotask(() => {
                callback(dataFor(function_.__lunoraRef, args));
            });

            return noop;
        },
        subscribeScheduledJobs: (callback: (jobs: unknown) => void): (() => void) => {
            queueMicrotask(() => {
                callback([{ id: "job_1", name: "clear presence", runAt: now + 60_000 }]);
            });

            return noop;
        },
    }) as unknown as LunoraClient;

export default createDevMockClient;
