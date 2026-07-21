import { LunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AggregateIndexDefinitionLike } from "../src/aggregates";
import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import { applyCdcChanges, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { DataMigrationLike, MigrationRunResult } from "../src/data-migration";
import { runDataMigration } from "../src/data-migration";
import type {
    AdvisoryFinding,
    FanoutMetricsResult,
    FanoutPathCounters,
    FanoutTopicStat,
    FlagEvaluation,
    FlagsResult,
    QueueMetadata,
    StudioFeaturesResult,
} from "../src/introspect";
import { ADMIN_FUNCTIONS } from "../src/introspect";
import type { MetricSeries } from "../src/metric-buffer";
import type { QueueMessageRow, RecordQueueMessageInput } from "../src/queue-catcher";
import type { RankIndexDefinitionLike, ShardRankPageResult } from "../src/rank";
import { rankKeyFromDoc } from "../src/rank";
import type {
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardMigrationArgs,
    RunShardRankBeforeArgs,
    RunShardRankPageArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
    ShardDOState,
} from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import type { MetricHistoryPoint, MetricHistorySeries } from "../src/metric-history";
import type { TraceSpan, TraceSummary } from "../src/span-buffer";
import type { SocketAttachment } from "../src/types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Canonical key set of `StudioFeaturesResult`. `@lunora/studio` hand-mirrors this
 * type (it can't import `@lunora/do`) and duplicates this exact tuple in its own
 * drift guard. `lint:types` fails here if a key is added to / removed from
 * `StudioFeaturesResult` without updating this tuple — and there if the studio
 * copy drifts — forcing both packages to move together.
 */
const STUDIO_FEATURE_KEYS = [
    "analytics",
    "auth",
    "containers",
    "flags",
    "kv",
    "mail",
    "payments",
    "queues",
    "scheduler",
    "storage",
    "vectors",
    "workflows",
] as const;

/** `true` only when `Keys` and `Canonical` are mutually assignable (the exact same key set). */
type KeysMatch<Keys extends string, Canonical extends string> = [Keys] extends [Canonical] ? ([Canonical] extends [Keys] ? true : never) : never;

// Compile-time drift guard: assigning `true` fails tsc the moment the key sets diverge.
const STUDIO_FEATURES_KEY_GUARD: KeysMatch<keyof StudioFeaturesResult, (typeof STUDIO_FEATURE_KEYS)[number]> = true;

/**
 * Canonical key set of `QueueMetadata`, duplicated by `@lunora/studio`'s hand
 * mirror the same way as `StudioFeaturesResult`. Forces both packages' copies of
 * the `listQueues` wire shape to move together. `deadLetterQueue` is optional.
 */
const QUEUE_METADATA_KEYS = ["binding", "deadLetterQueue", "exportName", "mode", "name"] as const;

const QUEUE_METADATA_KEY_GUARD: KeysMatch<keyof QueueMetadata, (typeof QUEUE_METADATA_KEYS)[number]> = true;

/**
 * Canonical key sets of `TraceSpan` / `TraceSummary` — the `getTraces` wire
 * shapes `@lunora/studio` hand-mirrors (it can't import `@lunora/do`) and
 * duplicates in its own drift guard. `lint:types` fails here if a key moves
 * without the tuple moving — and there if the studio copy drifts — so the
 * waterfall renderer can't silently fall behind the fold that feeds it.
 */
const TRACE_SPAN_KEYS = ["attributes", "depth", "durationMs", "error", "name", "offsetMs", "ok", "parentSpanId", "spanId"] as const;

const TRACE_SPAN_KEY_GUARD: KeysMatch<keyof TraceSpan, (typeof TRACE_SPAN_KEYS)[number]> = true;

const TRACE_SUMMARY_KEYS = ["durationMs", "functionPath", "ok", "rootName", "shardKey", "spans", "startTs", "traceId"] as const;

const TRACE_SUMMARY_KEY_GUARD: KeysMatch<keyof TraceSummary, (typeof TRACE_SUMMARY_KEYS)[number]> = true;

/**
 * Canonical key set of `MetricSeries` — the `getMetricSeries` wire shape
 * `@lunora/studio` hand-mirrors (it can't import `@lunora/do`) and duplicates in
 * its own drift guard. `lint:types` fails here if a key moves without the tuple
 * moving — and there if the studio copy drifts — so the Instruments table can't
 * silently fall behind the fold that feeds it. `attributes`/`shardKey` optional.
 */
const METRIC_SERIES_KEYS = [
    "attributes",
    "count",
    "exemplarTraceId",
    "firstTs",
    "functionPath",
    "kind",
    "last",
    "lastTs",
    "max",
    "min",
    "name",
    "shardKey",
    "sum",
] as const;

const METRIC_SERIES_KEY_GUARD: KeysMatch<keyof MetricSeries, (typeof METRIC_SERIES_KEYS)[number]> = true;

/**
 * Canonical key sets of the `getMetricHistory` wire shapes — the durable rollups
 * `@lunora/studio` hand-mirrors for the Instruments trend sparkline. `lint:types`
 * fails here if a key moves without the tuple — and there if the studio copy
 * drifts. `exemplarTraceId` (point), `attributes`/`shardKey` (series) optional.
 */
const METRIC_HISTORY_POINT_KEYS = ["bucketMs", "count", "exemplarTraceId", "last", "max", "min", "sum"] as const;

const METRIC_HISTORY_POINT_KEY_GUARD: KeysMatch<keyof MetricHistoryPoint, (typeof METRIC_HISTORY_POINT_KEYS)[number]> = true;

const METRIC_HISTORY_SERIES_KEYS = ["attributes", "functionPath", "kind", "name", "points", "shardKey"] as const;

const METRIC_HISTORY_SERIES_KEY_GUARD: KeysMatch<keyof MetricHistorySeries, (typeof METRIC_HISTORY_SERIES_KEYS)[number]> = true;

/**
 * Canonical key set of `QueueMessageRow` (the `getQueueMessages` consumed-message
 * log row), duplicated by `@lunora/studio`'s hand mirror the same way as the types
 * above. Forces both packages' copies of the log-row wire shape to move together —
 * `error`/`exportName` are optional.
 */
const QUEUE_MESSAGE_ROW_KEYS = [
    "attempts",
    "body",
    "capturedAt",
    "deadLettered",
    "error",
    "exportName",
    "id",
    "messageId",
    "outcome",
    "queue",
    "timestamp",
] as const;

const QUEUE_MESSAGE_ROW_KEY_GUARD: KeysMatch<keyof QueueMessageRow, (typeof QUEUE_MESSAGE_ROW_KEYS)[number]> = true;

/**
 * Canonical key set of `RecordQueueMessageInput` — the `recordQueueMessage`
 * admin-RPC payload the worker's capture sink POSTs. `@lunora/queue`'s
 * `CapturedQueueMessage` is its structural mirror across the deliberate
 * no-dependency-edge boundary and duplicates this exact tuple in its own drift
 * guard, so a field added to / dropped from either side fails that side's build
 * before a capture write silently loses (or forges) a column. `deadLettered` /
 * `error` / `exportName` are optional.
 */
const RECORD_QUEUE_MESSAGE_INPUT_KEYS = ["attempts", "body", "deadLettered", "error", "exportName", "messageId", "outcome", "queue", "timestamp"] as const;

const RECORD_QUEUE_MESSAGE_INPUT_KEY_GUARD: KeysMatch<keyof RecordQueueMessageInput, (typeof RECORD_QUEUE_MESSAGE_INPUT_KEYS)[number]> = true;

/**
 * Canonical key sets of `FlagEvaluation` / `FlagsResult`, duplicated by
 * `@lunora/studio`'s hand mirror the same way as the types above. Forces both
 * packages' copies of the `listFlags` wire shape to move together — so dropping
 * an optional field (`errorCode`/`reason`/`variant`) on one side fails the
 * build rather than silently shipping a missing studio cell.
 */
const FLAG_EVALUATION_KEYS = ["errorCode", "key", "reason", "type", "value", "variant"] as const;

const FLAG_EVALUATION_KEY_GUARD: KeysMatch<keyof FlagEvaluation, (typeof FLAG_EVALUATION_KEYS)[number]> = true;

const FLAGS_RESULT_KEYS = ["configured", "flags"] as const;

const FLAGS_RESULT_KEY_GUARD: KeysMatch<keyof FlagsResult, (typeof FLAGS_RESULT_KEYS)[number]> = true;

/**
 * Canonical key sets of the `getFanoutMetrics` wire shapes (plan 075 Phase 1),
 * duplicated by `@lunora/studio`'s hand mirror the same way as the types above.
 * Forces both packages' copies of the fan-out observability payload to move
 * together — adding or dropping a counter/topic field fails the build rather than
 * silently shipping a missing studio cell.
 */
const FANOUT_TOPIC_STAT_KEYS = ["kind", "subscribers", "topic"] as const;

const FANOUT_TOPIC_STAT_KEY_GUARD: KeysMatch<keyof FanoutTopicStat, (typeof FANOUT_TOPIC_STAT_KEYS)[number]> = true;

const FANOUT_PATH_COUNTERS_KEYS = ["maxMs", "passes", "peakSocketsIterated", "socketsDelivered", "socketsIterated", "totalMs"] as const;

const FANOUT_PATH_COUNTERS_KEY_GUARD: KeysMatch<keyof FanoutPathCounters, (typeof FANOUT_PATH_COUNTERS_KEYS)[number]> = true;

const FANOUT_METRICS_RESULT_KEYS = [
    "maxRelays",
    "peakSubscribers",
    "promoted",
    "relayCount",
    "shapePoke",
    "sinceMs",
    "topics",
    "totalConnections",
    "whisper",
] as const;

const FANOUT_METRICS_RESULT_KEY_GUARD: KeysMatch<keyof FanoutMetricsResult, (typeof FANOUT_METRICS_RESULT_KEYS)[number]> = true;

/**
 * A real-SQLite-backed ShardDO whose `handleRpc` throws — proving the admin
 * branch in `fetch` short-circuits before user dispatch is ever reached.
 */
class AdminShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }
}

/**
 * Mirrors the codegen subclass that overrides `workflowsMetadata()` with the
 * project's discovered workflow declarations — shared by every test that needs
 * a shard which "sees" the order-pipeline workflow.
 */
class DeclaredWorkflowShard extends AdminShard {
    // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
    protected override workflowsMetadata(): { workflows: { binding: string; className: string; exportName: string; name: string }[] } {
        return {
            workflows: [{ binding: "WORKFLOW_ORDER_PIPELINE", className: "OrderPipelineWorkflow", exportName: "orderPipeline", name: "order-pipeline" }],
        };
    }
}

/**
 * Mirrors the codegen subclass that overrides `queuesMetadata()` with the
 * project's discovered queue declarations — a push email queue plus a pull
 * reports queue.
 */
class DeclaredQueueShard extends AdminShard {
    // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
    protected override queuesMetadata(): { queues: { binding: string; deadLetterQueue?: string; exportName: string; mode: "pull" | "push"; name: string }[] } {
        return {
            queues: [
                { binding: "QUEUE_EMAIL", deadLetterQueue: "email-dlq", exportName: "emailQueue", mode: "push", name: "email" },
                { binding: "QUEUE_REPORTS", exportName: "reportsQueue", mode: "pull", name: "reports" },
            ],
        };
    }
}

const ADMIN_TOKEN = "s3cret-admin";

/**
 * A shard whose `handleRpc` fails for one marked path, so the request/error
 * counters and the log buffer can be driven through the public `fetch` surface.
 */
class CountingShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; routes by functionPath only, no instance state
    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "boom:explode") {
            throw new Error("boom");
        }

        return { ok: true };
    }
}

/**
 * Exposes the protected `recordUserLog` so the `ctx.log` capture path — buffer
 * push, console event, optional sink — can be driven directly the way the
 * codegen-generated `buildCtx` logger closure drives it.
 */
class LoggingShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; this shard exists only to expose recordUserLog
    public override async handleRpc(): Promise<unknown> {
        return { ok: true };
    }

    public log(
        functionPath: string,
        level: "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn",
        args: unknown[],
        sink?: Parameters<LoggingShard["makeLogger"]>[1],
    ): void {
        // Drive the real logger the generated `buildCtx` builds — arg parsing
        // (structured vs console-style), buffer push, console event, and sink.
        this.makeLogger(functionPath, sink)[level](...args);
    }

    /** Expose the built `ctx.log` logger so tests can drive `.with(...)` and overloads directly. */
    public logger(functionPath: string, sink?: Parameters<LoggingShard["makeLogger"]>[1]): ReturnType<LoggingShard["makeLogger"]> {
        return this.makeLogger(functionPath, sink);
    }
}

/** An ordinary (non-admin) RPC request — no bearer, so it routes to `handleRpc`. */
const userRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("shardDO admin introspection", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        database.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT)`);
        database.raw(`INSERT INTO "messages" VALUES ('m1', 'hello'), ('m2', 'world')`);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const adminRequest = (functionPath: string, args: Record<string, unknown>, token?: string): Request => {
        const headers: Record<string, string> = { "content-type": "application/json" };

        if (token !== undefined) {
            headers.authorization = `Bearer ${token}`;
        }

        return new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath }),
            headers,
            method: "POST",
        });
    };

    /** Shape of a `getQueueMessages` admin response — `Response.json()` is `unknown` under strict TS. */
    interface QueueMessagesRead {
        result: { entries: { id: string; messageId: string }[] };
    }

    // Typing the param's `json()` as `Promise<unknown>` keeps the narrowing assertion
    // necessary under BOTH tsc (workers-types `.json()` is `unknown`) and ESLint's
    // typed program (DOM lib `.json()` is `any`, which would flag an inline cast).
    const readQueueMessages = async (response: { json: () => Promise<unknown> }): Promise<QueueMessagesRead> => (await response.json()) as QueueMessagesRead;

    it("lists tables when a valid admin bearer is presented", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ result: [{ name: "messages", rowCount: 2 }] });
    });

    it("reads a page of rows for a table", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.readTablePage, { limit: 1, table: "messages" }, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: { columns: ["__id__", "text"], rows: [{ __id__: "m1", text: "hello" }], total: 2 },
        });
    });

    it("reports no indexes from the base hook, and the subclass-declared ones when overridden", async () => {
        expect.assertions(2);

        // Base ShardDO can't see the user schema, so it reports an empty list.
        const base = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.listTableIndexes, { table: "messages" }, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { indexes: [] } });

        // The codegen subclass overrides `tableIndexes` from the schema; mimic it.
        class IndexedShard extends AdminShard {
            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override tableIndexes(
                table: string,
            ): { fields: string[]; name: string; type: "index" | "rank" | "search" | "vector"; unique?: boolean }[] {
                return table === "messages" ? [{ fields: ["author"], name: "by_author", type: "index", unique: true }] : [];
            }
        }

        const indexed = new IndexedShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await indexed.fetch(adminRequest(ADMIN_FUNCTIONS.listTableIndexes, { table: "messages" }, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: { indexes: [{ fields: ["author"], name: "by_author", type: "index", unique: true }] },
        });
    });

    it("reports no columns from the base hook, and the subclass-declared ones when overridden", async () => {
        expect.assertions(2);

        // Base ShardDO can't see the user schema, so it reports an empty list.
        const base = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.describeTable, { table: "messages" }, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { columns: [] } });

        // The codegen subclass overrides `tableColumns` from the schema; mimic it.
        class ColumnsShard extends AdminShard {
            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override tableColumns(
                table: string,
            ): { isStorage?: boolean; name: string; optional: boolean; pk?: boolean; ref?: string; type: string }[] {
                return table === "messages"
                    ? [
                          { name: "_id", optional: false, pk: true, type: "id" },
                          { name: "_creationTime", optional: false, type: "number" },
                          { name: "channelId", optional: false, ref: "channels", type: "id" },
                          { name: "text", optional: false, type: "string" },
                      ]
                    : [];
            }
        }

        const columns = new ColumnsShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await columns.fetch(adminRequest(ADMIN_FUNCTIONS.describeTable, { table: "messages" }, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: {
                columns: [
                    { name: "_id", optional: false, pk: true, type: "id" },
                    { name: "_creationTime", optional: false, type: "number" },
                    { name: "channelId", optional: false, ref: "channels", type: "id" },
                    { name: "text", optional: false, type: "string" },
                ],
            },
        });
    });

    it("returns columns for several tables in one describeTables call", async () => {
        expect.assertions(2);

        class ColumnsShard extends AdminShard {
            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override tableColumns(
                table: string,
            ): { isStorage?: boolean; name: string; optional: boolean; pk?: boolean; ref?: string; type: string }[] {
                if (table === "messages") {
                    return [
                        { name: "_id", optional: false, pk: true, type: "id" },
                        { name: "text", optional: false, type: "string" },
                    ];
                }

                return table === "users" ? [{ name: "_id", optional: false, pk: true, type: "id" }] : [];
            }
        }

        const shard = new ColumnsShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // Base hook still reports nothing per-table for an unknown table.
        const base = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.describeTables, { tables: ["messages"] }, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { columnsByTable: { messages: [] } } });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.describeTables, { tables: ["messages", "users"] }, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: {
                columnsByTable: {
                    messages: [
                        { name: "_id", optional: false, pk: true, type: "id" },
                        { name: "text", optional: false, type: "string" },
                    ],
                    users: [{ name: "_id", optional: false, pk: true, type: "id" }],
                },
            },
        });
    });

    it("reports no advisories from the base hook, and the subclass-declared ones when overridden", async () => {
        expect.assertions(2);

        // Base ShardDO can't see the user schema, so it reports none.
        const base = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.getAdvisories, {}, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { advisories: [] } });

        // The codegen subclass overrides `advisories()` with the baked list.
        const finding: AdvisoryFinding = {
            cacheKey: "unindexed_foreign_key:posts:authorId",
            categories: ["PERFORMANCE"],
            description: "A foreign-key column has no index.",
            detail: 'Relation "author" on table "posts" references "users" via column "authorId".',
            facing: "EXTERNAL",
            level: "INFO",
            metadata: { table: "posts" },
            name: "unindexed_foreign_key",
            remediation: "Add an index leading with the FK column.",
            title: "Unindexed foreign key",
        };

        class AdvisedShard extends AdminShard {
            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override advisories(): AdvisoryFinding[] {
                return [finding];
            }
        }

        const advised = new AdvisedShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await advised.fetch(adminRequest(ADMIN_FUNCTIONS.getAdvisories, {}, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({ result: { advisories: [finding] } });
    });

    it("reports every studio feature off from the base hook, and the subclass-declared flags when overridden", async () => {
        expect.assertions(2);

        // Base ShardDO can't see the user's project, so it hides every optional page.
        const base = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.studioFeatures, {}, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({
            result: {
                analytics: false,
                auth: false,
                containers: false,
                flags: false,
                kv: false,
                mail: false,
                payments: false,
                queues: false,
                scheduler: false,
                storage: false,
                vectors: false,
                workflows: false,
            },
        });

        // The codegen subclass overrides `studioFeatures()` with the discovered flags.
        class FeaturedShard extends AdminShard {
            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override studioFeatures(): {
                analytics: boolean;
                auth: boolean;
                containers: boolean;
                flags: boolean;
                kv: boolean;
                mail: boolean;
                payments: boolean;
                queues: boolean;
                scheduler: boolean;
                storage: boolean;
                vectors: boolean;
                workflows: boolean;
            } {
                return {
                    analytics: false,
                    auth: false,
                    containers: true,
                    flags: true,
                    kv: false,
                    mail: false,
                    payments: true,
                    queues: true,
                    scheduler: true,
                    storage: false,
                    vectors: false,
                    workflows: true,
                };
            }
        }

        const featured = new FeaturedShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await featured.fetch(adminRequest(ADMIN_FUNCTIONS.studioFeatures, {}, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: {
                analytics: false,
                auth: false,
                containers: true,
                flags: true,
                kv: false,
                mail: false,
                payments: true,
                queues: true,
                scheduler: true,
                storage: false,
                vectors: false,
                workflows: true,
            },
        });
    });

    it("reports no flags from the base listFlags hook, and the subclass evaluation when overridden", async () => {
        expect.assertions(2);

        // Base ShardDO wires no provider, so listFlags reports unconfigured.
        const base = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.listFlags, {}, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { configured: false, flags: [] } });

        // The codegen subclass overrides `evaluateFlags` with live evaluation; it
        // receives the editable targeting context the studio supplies.
        class FlaggedShard extends AdminShard {
            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override evaluateFlags(context?: Record<string, unknown>): Promise<{
                configured: boolean;
                flags: { key: string; reason: string; type: "boolean" | "number" | "object" | "string"; value: unknown }[];
            }> {
                return Promise.resolve({
                    configured: true,
                    flags: [{ key: "dark-mode", reason: "TARGETING_MATCH", type: "boolean", value: context?.plan === "premium" }],
                });
            }
        }

        const flagged = new FlaggedShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await flagged.fetch(adminRequest(ADMIN_FUNCTIONS.listFlags, { context: { plan: "premium" } }, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: { configured: true, flags: [{ key: "dark-mode", reason: "TARGETING_MATCH", type: "boolean", value: true }] },
        });
    });

    it("keeps StudioFeaturesResult's keys in lockstep with the studio's hand-mirror", () => {
        expect.assertions(2);

        // The compile-time guard (STUDIO_FEATURES_KEY_GUARD) is what actually fails
        // the build on drift; this asserts the tuple matches the wire shape at runtime too.
        expect(STUDIO_FEATURES_KEY_GUARD).toBe(true);
        expect([...STUDIO_FEATURE_KEYS]).toStrictEqual([
            "analytics",
            "auth",
            "containers",
            "flags",
            "kv",
            "mail",
            "payments",
            "queues",
            "scheduler",
            "storage",
            "vectors",
            "workflows",
        ]);
    });

    it("keeps QueueMetadata's keys in lockstep with the studio's hand-mirror", () => {
        expect.assertions(2);

        expect(QUEUE_METADATA_KEY_GUARD).toBe(true);
        expect([...QUEUE_METADATA_KEYS]).toStrictEqual(["binding", "deadLetterQueue", "exportName", "mode", "name"]);
    });

    it("keeps the getTraces wire shapes in lockstep with the studio's hand-mirror", () => {
        expect.assertions(3);

        // The compile-time guards are what actually fail the build on drift; these
        // assert the tuples match the wire shapes at runtime too.
        expect(TRACE_SPAN_KEY_GUARD).toBe(true);
        expect(TRACE_SUMMARY_KEY_GUARD).toBe(true);
        expect([...TRACE_SUMMARY_KEYS]).toStrictEqual(["durationMs", "functionPath", "ok", "rootName", "shardKey", "spans", "startTs", "traceId"]);
    });

    it("keeps the getMetricSeries wire shape in lockstep with the studio's hand-mirror", () => {
        expect.assertions(2);

        expect(METRIC_SERIES_KEY_GUARD).toBe(true);
        expect([...METRIC_SERIES_KEYS]).toStrictEqual([
            "attributes",
            "count",
            "exemplarTraceId",
            "firstTs",
            "functionPath",
            "kind",
            "last",
            "lastTs",
            "max",
            "min",
            "name",
            "shardKey",
            "sum",
        ]);
    });

    it("keeps the getMetricHistory wire shapes in lockstep with the studio's hand-mirror", () => {
        expect.assertions(4);

        expect(METRIC_HISTORY_POINT_KEY_GUARD).toBe(true);
        expect([...METRIC_HISTORY_POINT_KEYS]).toStrictEqual(["bucketMs", "count", "exemplarTraceId", "last", "max", "min", "sum"]);
        expect(METRIC_HISTORY_SERIES_KEY_GUARD).toBe(true);
        expect([...METRIC_HISTORY_SERIES_KEYS]).toStrictEqual(["attributes", "functionPath", "kind", "name", "points", "shardKey"]);
    });

    it("keeps QueueMessageRow's keys in lockstep with the studio's hand-mirror", () => {
        expect.assertions(2);

        expect(QUEUE_MESSAGE_ROW_KEY_GUARD).toBe(true);
        expect([...QUEUE_MESSAGE_ROW_KEYS]).toStrictEqual([
            "attempts",
            "body",
            "capturedAt",
            "deadLettered",
            "error",
            "exportName",
            "id",
            "messageId",
            "outcome",
            "queue",
            "timestamp",
        ]);
    });

    it("keeps RecordQueueMessageInput's keys in lockstep with @lunora/queue's CapturedQueueMessage", () => {
        expect.assertions(2);

        expect(RECORD_QUEUE_MESSAGE_INPUT_KEY_GUARD).toBe(true);
        expect([...RECORD_QUEUE_MESSAGE_INPUT_KEYS]).toStrictEqual([
            "attempts",
            "body",
            "deadLettered",
            "error",
            "exportName",
            "messageId",
            "outcome",
            "queue",
            "timestamp",
        ]);
    });

    it("keeps FlagEvaluation/FlagsResult keys in lockstep with the studio's hand-mirror", () => {
        expect.assertions(4);

        expect(FLAG_EVALUATION_KEY_GUARD).toBe(true);
        expect([...FLAG_EVALUATION_KEYS]).toStrictEqual(["errorCode", "key", "reason", "type", "value", "variant"]);
        expect(FLAGS_RESULT_KEY_GUARD).toBe(true);
        expect([...FLAGS_RESULT_KEYS]).toStrictEqual(["configured", "flags"]);
    });

    it("keeps the getFanoutMetrics wire shapes in lockstep with the studio's hand-mirror", () => {
        expect.assertions(6);

        expect(FANOUT_TOPIC_STAT_KEY_GUARD).toBe(true);
        expect([...FANOUT_TOPIC_STAT_KEYS]).toStrictEqual(["kind", "subscribers", "topic"]);
        expect(FANOUT_PATH_COUNTERS_KEY_GUARD).toBe(true);
        expect([...FANOUT_PATH_COUNTERS_KEYS]).toStrictEqual(["maxMs", "passes", "peakSocketsIterated", "socketsDelivered", "socketsIterated", "totalMs"]);
        expect(FANOUT_METRICS_RESULT_KEY_GUARD).toBe(true);
        expect([...FANOUT_METRICS_RESULT_KEYS]).toStrictEqual([
            "maxRelays",
            "peakSubscribers",
            "promoted",
            "relayCount",
            "shapePoke",
            "sinceMs",
            "topics",
            "totalConnections",
            "whisper",
        ]);
    });

    it("serves declared-workflow metadata from the codegen-overridden hook", async () => {
        expect.assertions(2);

        // Base ShardDO can't see the user's project, so it lists no workflows.
        const base = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.listWorkflows, {}, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { workflows: [] } });

        // The codegen subclass overrides `workflowsMetadata()` with the discovered declarations.
        const withWorkflows = new DeclaredWorkflowShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await withWorkflows.fetch(adminRequest(ADMIN_FUNCTIONS.listWorkflows, {}, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: {
                workflows: [{ binding: "WORKFLOW_ORDER_PIPELINE", className: "OrderPipelineWorkflow", exportName: "orderPipeline", name: "order-pipeline" }],
            },
        });
    });

    it("serves declared-queue metadata from the codegen-overridden hook", async () => {
        expect.assertions(2);

        // Base ShardDO can't see the user's project, so it lists no queues.
        const base = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.listQueues, {}, ADMIN_TOKEN));

        await expect(baseResponse.json()).resolves.toEqual({ result: { queues: [] } });

        // The codegen subclass overrides `queuesMetadata()` with the discovered declarations.
        const withQueues = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await withQueues.fetch(adminRequest(ADMIN_FUNCTIONS.listQueues, {}, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: {
                queues: [
                    { binding: "QUEUE_EMAIL", deadLetterQueue: "email-dlq", exportName: "emailQueue", mode: "push", name: "email" },
                    { binding: "QUEUE_REPORTS", exportName: "reportsQueue", mode: "pull", name: "reports" },
                ],
            },
        });
    });

    it("records consumed messages and reads them back newest-first", async () => {
        expect.assertions(4);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const recordResponse = await shard.fetch(
            adminRequest(
                ADMIN_FUNCTIONS.recordQueueMessage,
                {
                    messages: [
                        { attempts: 1, body: { n: 1 }, exportName: "emailQueue", messageId: "cf-1", outcome: "ack", queue: "email", timestamp: 10 },
                        {
                            attempts: 3,
                            body: { n: 2 },
                            deadLettered: true,
                            error: "kaboom",
                            exportName: "emailQueue",
                            messageId: "cf-2",
                            outcome: "error",
                            queue: "email",
                            timestamp: 20,
                        },
                    ],
                },
                ADMIN_TOKEN,
            ),
        );

        await expect(recordResponse.json()).resolves.toEqual({ result: { recorded: 2 } });

        const readResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getQueueMessages, {}, ADMIN_TOKEN));
        const read = await readQueueMessages(readResponse);

        expect(read.result.entries).toHaveLength(2);

        // Both were captured in one batch (shared `capturedAt`), so index order is
        // undefined — assert each row by its message id.
        const byId = new Map(read.result.entries.map((entry) => [entry.messageId, entry]));

        expect(byId.get("cf-1")).toMatchObject({ attempts: 1, deadLettered: false, outcome: "ack" });
        expect(byId.get("cf-2")).toMatchObject({ attempts: 3, deadLettered: true, error: "kaboom", outcome: "error" });
    });

    it("sends a single message through the declared producer binding", async () => {
        expect.assertions(3);

        const sent: { body: unknown; options?: unknown }[] = [];
        const binding = {
            send: (body: unknown, options?: unknown) => {
                sent.push({ body, options });

                return Promise.resolve();
            },
            sendBatch: () => Promise.reject(new Error("sendBatch must not run for a single send")),
        };

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, QUEUE_EMAIL: binding });
        const response = await shard.fetch(
            adminRequest(ADMIN_FUNCTIONS.sendQueueMessage, { body: { hi: true }, delaySeconds: 5, exportName: "emailQueue" }, ADMIN_TOKEN),
        );

        await expect(response.json()).resolves.toEqual({ result: { sent: 1 } });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toStrictEqual({ body: { hi: true }, options: { contentType: undefined, delaySeconds: 5 } });
    });

    it("sends a batch through the declared producer binding", async () => {
        expect.assertions(2);

        const batches: unknown[] = [];
        const binding = {
            send: () => Promise.reject(new Error("send must not run for a batch")),
            sendBatch: (messages: Iterable<unknown>) => {
                batches.push([...messages]);

                return Promise.resolve();
            },
        };

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, QUEUE_EMAIL: binding });
        const response = await shard.fetch(
            adminRequest(ADMIN_FUNCTIONS.sendQueueMessage, { batch: [{ a: 1 }, { a: 2 }], exportName: "emailQueue" }, ADMIN_TOKEN),
        );

        await expect(response.json()).resolves.toEqual({ result: { sent: 2 } });
        expect(batches).toStrictEqual([
            [
                { body: { a: 1 }, contentType: undefined, delaySeconds: undefined },
                { body: { a: 2 }, contentType: undefined, delaySeconds: undefined },
            ],
        ]);
    });

    it("rejects an empty batch with a 400 before touching the queue binding", async () => {
        expect.assertions(2);

        const binding = {
            send: () => Promise.reject(new Error("send must not run for an invalid batch")),
            sendBatch: () => Promise.reject(new Error("sendBatch must not run for an empty batch")),
        };

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, QUEUE_EMAIL: binding });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.sendQueueMessage, { batch: [], exportName: "emailQueue" }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toMatch(/between 1 and 100/u);
    });

    it("rejects a batch larger than 100 messages with a 400", async () => {
        expect.assertions(1);

        const binding = {
            send: () => Promise.reject(new Error("send must not run for an oversized batch")),
            sendBatch: () => Promise.reject(new Error("sendBatch must not run for an oversized batch")),
        };

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, QUEUE_EMAIL: binding });
        const oversized = Array.from({ length: 101 }, (_unused, index) => {
            return { n: index };
        });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.sendQueueMessage, { batch: oversized, exportName: "emailQueue" }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
    });

    it("rejects sending to an undeclared queue with a 400", async () => {
        expect.assertions(1);

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.sendQueueMessage, { body: {}, exportName: "ghost" }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
    });

    it("rejects sending to a declared queue whose binding is absent with a 400", async () => {
        expect.assertions(1);

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.sendQueueMessage, { body: {}, exportName: "emailQueue" }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
    });

    it("replays a captured message back onto the queue it came from", async () => {
        expect.assertions(2);

        const sent: unknown[] = [];
        const binding = {
            send: (body: unknown) => {
                sent.push(body);

                return Promise.resolve();
            },
            sendBatch: () => Promise.reject(new Error("sendBatch must not run for a replay")),
        };

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, QUEUE_EMAIL: binding });

        await shard.fetch(
            adminRequest(
                ADMIN_FUNCTIONS.recordQueueMessage,
                { messages: [{ attempts: 1, body: { replay: "me" }, messageId: "cf-9", outcome: "ack", queue: "email", timestamp: 0 }] },
                ADMIN_TOKEN,
            ),
        );

        const readResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getQueueMessages, {}, ADMIN_TOKEN));
        const read = await readQueueMessages(readResponse);
        const [captured] = read.result.entries;
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.replayQueueMessage, { id: captured?.id }, ADMIN_TOKEN));

        // `email` resolves to its producer export `emailQueue`.
        await expect(response.json()).resolves.toEqual({ result: { sent: 1, target: "emailQueue" } });
        expect(sent).toStrictEqual([{ replay: "me" }]);
    });

    it("redrives a dead-lettered message onto its parent queue", async () => {
        expect.assertions(2);

        const sent: unknown[] = [];
        const binding = {
            send: (body: unknown) => {
                sent.push(body);

                return Promise.resolve();
            },
            sendBatch: () => Promise.reject(new Error("sendBatch must not run for a redrive")),
        };

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, QUEUE_EMAIL: binding });

        // Captured off the DLQ (`email-dlq`); replay should target the parent `emailQueue`.
        await shard.fetch(
            adminRequest(
                ADMIN_FUNCTIONS.recordQueueMessage,
                {
                    messages: [
                        { attempts: 3, body: { dead: true }, deadLettered: true, messageId: "cf-dlq", outcome: "error", queue: "email-dlq", timestamp: 0 },
                    ],
                },
                ADMIN_TOKEN,
            ),
        );

        const readResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getQueueMessages, {}, ADMIN_TOKEN));
        const read = await readQueueMessages(readResponse);
        const [captured] = read.result.entries;
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.replayQueueMessage, { id: captured?.id }, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({ result: { sent: 1, target: "emailQueue" } });
        expect(sent).toStrictEqual([{ dead: true }]);
    });

    it("refuses to replay a truncated (lossy) captured body", async () => {
        expect.assertions(2);

        const sent: unknown[] = [];
        const binding = {
            send: (body: unknown) => {
                sent.push(body);

                return Promise.resolve();
            },
            sendBatch: () => Promise.reject(new Error("sendBatch must not run")),
        };

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, QUEUE_EMAIL: binding });

        // A body larger than the catcher's per-row cap is stored as a truncated
        // marker string, so the stored body is no longer the original payload —
        // replaying it would deliver a corrupted message.
        await shard.fetch(
            adminRequest(
                ADMIN_FUNCTIONS.recordQueueMessage,
                { messages: [{ attempts: 1, body: "x".repeat(200 * 1024), messageId: "cf-big", outcome: "ack", queue: "email", timestamp: 0 }] },
                ADMIN_TOKEN,
            ),
        );

        const readResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getQueueMessages, {}, ADMIN_TOKEN));
        const read = await readQueueMessages(readResponse);
        const [captured] = read.result.entries;
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.replayQueueMessage, { id: captured?.id }, ADMIN_TOKEN));

        expect(response.status).toBe(422);
        expect(sent).toStrictEqual([]);
    });

    it("rejects replaying an unknown captured id with a 404", async () => {
        expect.assertions(1);

        const shard = new DeclaredQueueShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.replayQueueMessage, { id: "does-not-exist" }, ADMIN_TOKEN));

        expect(response.status).toBe(404);
    });

    it("clears the consumed-message log", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(
            adminRequest(
                ADMIN_FUNCTIONS.recordQueueMessage,
                { messages: [{ attempts: 1, body: 1, messageId: "cf-x", outcome: "ack", queue: "email", timestamp: 0 }] },
                ADMIN_TOKEN,
            ),
        );

        const clearResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.clearQueueMessages, {}, ADMIN_TOKEN));

        await expect(clearResponse.json()).resolves.toEqual({ result: { cleared: true } });

        const readResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getQueueMessages, {}, ADMIN_TOKEN));
        const read = await readQueueMessages(readResponse);

        expect(read.result.entries).toHaveLength(0);
    });

    it("starts a workflow instance through the declared binding", async () => {
        expect.assertions(2);

        const created: { id?: string; params?: unknown }[] = [];

        const binding = {
            create: (options: { id?: string; params?: unknown }) => {
                created.push(options);

                return Promise.resolve({ id: options.id ?? "wf-generated", status: () => Promise.resolve({ status: "queued" }) });
            },
            get: () => Promise.reject(new Error("get must not run for create")),
        };

        // A shard whose env carries a fake `WORKFLOW_*` binding and whose
        // codegen hook declares the matching workflow.
        const shard = new DeclaredWorkflowShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, WORKFLOW_ORDER_PIPELINE: binding });
        const response = await shard.fetch(
            adminRequest(ADMIN_FUNCTIONS.createWorkflowInstance, { exportName: "orderPipeline", params: { orderId: "o1" } }, ADMIN_TOKEN),
        );

        await expect(response.json()).resolves.toEqual({ result: { id: "wf-generated", status: "queued" } });
        expect(created).toStrictEqual([{ id: undefined, params: { orderId: "o1" } }]);
    });

    it("reports a workflow instance's status, output, and error", async () => {
        expect.assertions(1);

        const binding = {
            create: () => Promise.reject(new Error("create must not run for status")),
            get: (id: string) => Promise.resolve({ id, status: () => Promise.resolve({ output: { total: 42 }, status: "complete" }) }),
        };

        const shard = new DeclaredWorkflowShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, WORKFLOW_ORDER_PIPELINE: binding });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getWorkflowInstanceStatus, { exportName: "orderPipeline", id: "wf-1" }, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({ result: { id: "wf-1", output: { total: 42 }, status: "complete" } });
    });

    it("rejects starting an undeclared workflow with a 400", async () => {
        expect.assertions(1);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.createWorkflowInstance, { exportName: "ghost" }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
    });

    it("rejects starting a declared workflow whose binding is absent with a 400", async () => {
        expect.assertions(1);

        // Declares the workflow but provides no matching env binding.
        const shard = new DeclaredWorkflowShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.createWorkflowInstance, { exportName: "orderPipeline" }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
    });

    it("derives an unused_index runtime advisory for a declared index no query exercised", async () => {
        expect.assertions(2);

        // A shard that declares two indexes on `posts` and lets a test exercise one.
        class UnusedIndexShard extends AdminShard {
            /** Simulate a query exercising `table`'s `index`, the way the ctx-db read hook would. */
            public exercise(table: string, index: string): void {
                this.getCtxDbIndexUseHook()(table, index);
            }

            // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
            protected override tableIndexes(
                table: string,
            ): { fields: string[]; name: string; type: "index" | "rank" | "search" | "vector"; unique?: boolean }[] {
                return table === "posts"
                    ? [
                          { fields: ["authorId"], name: "byAuthor", type: "index" },
                          { fields: ["createdAt"], name: "byCreated", type: "index" },
                      ]
                    : [];
            }
        }

        const shard = new UnusedIndexShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // No reads yet → no runtime advisories (a never-queried table never spams).
        const cold = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAdvisories, {}, ADMIN_TOKEN));

        await expect(cold.json()).resolves.toEqual({ result: { advisories: [] } });

        // A query exercises `byAuthor`; `byCreated` is now the unused one. The
        // exact `toEqual` asserts a single finding — so `byAuthor` is absent.
        shard.exercise("posts", "byAuthor");

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAdvisories, {}, ADMIN_TOKEN));

        await expect(response.json()).resolves.toEqual({
            result: {
                advisories: [
                    {
                        cacheKey: "unused_index:posts:byCreated",
                        categories: ["PERFORMANCE"],
                        description: expect.any(String),
                        detail: expect.any(String),
                        facing: "INTERNAL",
                        level: "INFO",
                        metadata: { index: "byCreated", indexKind: "index", since: "instance-woke", table: "posts" },
                        name: "unused_index",
                        remediation: expect.any(String),
                        title: "Unused index",
                    },
                ],
            },
        });
    });

    it("is disabled (403) when no admin token is configured, even with a bearer", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, {});

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, ADMIN_TOKEN));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "ADMIN_FORBIDDEN" } });
    });

    it("rejects (403) a missing or mismatched bearer when a token is configured", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const missing = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}));
        const wrong = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listTables, {}, "wrong"));

        expect(missing.status).toBe(403);
        expect(wrong.status).toBe(403);
    });

    it("maps an unknown table to a 404 LunoraError", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.readTablePage, { table: "nope" }, ADMIN_TOKEN));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });

    it("returns 404 for an unrecognised admin op", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest("__lunora_admin__:bogus", {}, ADMIN_TOKEN));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_ADMIN_OP" } });
    });

    it("listSubscriptions enumerates connected sockets, their subs, and aggregate counts", async () => {
        expect.assertions(2);

        // A socket whose attachment is read back via `deserializeAttachment`,
        // mirroring the workerd hibernation surface `readAttachment` uses.
        const makeSocket = (attachment: SocketAttachment): WebSocket => ({ deserializeAttachment: () => attachment }) as unknown as WebSocket;

        const sockets: WebSocket[] = [
            makeSocket({ admin: true, subs: { "s-1": { args: { room: "general" }, functionPath: "messages:list", table: "messages" } } }),
            makeSocket({
                subs: {
                    "s-a": { functionPath: "presence:list", table: "presence" },
                    "s-b": { args: { since: 5 }, functionPath: "feed:recent", table: "posts" },
                },
            }),
            makeSocket({ subs: {} }),
        ];
        const socketState: ShardDOState = { ...state, getWebSockets: () => sockets };
        const shard = new AdminShard(socketState, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listSubscriptions, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: {
                connections: [
                    { admin: true, id: 0, subscriptions: [{ args: { room: "general" }, functionPath: "messages:list", table: "messages" }] },
                    {
                        admin: false,
                        id: 1,
                        subscriptions: [
                            { functionPath: "presence:list", table: "presence" },
                            { args: { since: 5 }, functionPath: "feed:recent", table: "posts" },
                        ],
                    },
                    { admin: false, id: 2, subscriptions: [] },
                ],
                totalConnections: 3,
                totalSubscriptions: 3,
            },
        });
    });

    it("listSubscriptions returns an empty, zeroed result when no sockets are connected", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.listSubscriptions, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ result: { connections: [], totalConnections: 0, totalSubscriptions: 0 } });
    });

    it("recordAuthEvent then getAuthMetrics round-trips the app-level auth-failure signal", async () => {
        expect.assertions(6);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // Two successful attempts and one failure, recorded via the write op.
        const ok1 = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "ok" }, ADMIN_TOKEN));
        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "ok" }, ADMIN_TOKEN));
        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "fail" }, ADMIN_TOKEN));

        expect(ok1.status).toBe(200);
        await expect(ok1.json()).resolves.toEqual({ result: { recorded: true } });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAuthMetrics, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { attempts: number; failureRate: number; failures: number; history: unknown[] } }>();

        expect(body.result).toMatchObject({ attempts: 3, failures: 1 });
        // 1 failure / 3 attempts.
        expect(body.result.failureRate).toBeCloseTo(1 / 3, 10);
        expect(body.result.history.length).toBeGreaterThan(0);
    });

    it("rejects (400) a recordAuthEvent with an invalid outcome", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "bogus" }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("admin-gates recordAuthEvent and getAuthMetrics (403 without the bearer)", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const recordResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordAuthEvent, { outcome: "ok" }));
        const readResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAuthMetrics, {}));

        expect(recordResponse.status).toBe(403);
        expect(readResponse.status).toBe(403);
    });

    it("recordContainerEvent surfaces a container lifecycle event in the getLogs stream", async () => {
        expect.assertions(4);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const envelope = {
            container: "transcoder",
            event: "stop",
            instance: "do-abc123",
            level: "info",
            message: "runtime_signal (exit 137)",
            source: "lunora",
            ts: 1_700_000_000_000,
            type: "container",
        };

        const recorded = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordContainerEvent, { event: envelope }, ADMIN_TOKEN));

        expect(recorded.status).toBe(200);
        await expect(recorded.json()).resolves.toEqual({ result: { recorded: true } });

        const logs = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}, ADMIN_TOKEN));
        const body = await logs.json<{
            result: { entries: { exitCode?: number; functionPath?: string; instance?: string; level: string; message: string; timestamp: number }[] };
        }>();

        expect(logs.status).toBe(200);
        // `functionPath` groups it as a container source; the message folds the
        // transition and the detail; the timestamp is the envelope's `ts`; the
        // per-instance DO id and the `(exit <n>)` code are carried through.
        expect(body.result.entries).toContainEqual({
            exitCode: 137,
            functionPath: "container:transcoder",
            instance: "do-abc123",
            level: "info",
            message: "stop: runtime_signal (exit 137)",
            timestamp: 1_700_000_000_000,
        });
    });

    it("folds an error-level container event into the getIssues stream", async () => {
        expect.assertions(3);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // Two crashes of the same container with different instance ids: they
        // share the `container:transcoder :: bucket(message)` fingerprint, so
        // getIssues folds them into one Issue with count 2 — right beside any
        // Worker error, since both go through the same durable readout.
        const crash = (instance: string) => {
            return {
                container: "transcoder",
                event: "error",
                instance,
                level: "error",
                message: "OOM killed (exit 137)",
                source: "lunora",
                ts: 1_700_000_000_000,
                type: "container",
            };
        };

        const first = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordContainerEvent, { event: crash("do-a") }, ADMIN_TOKEN));
        const second = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordContainerEvent, { event: crash("do-b") }, ADMIN_TOKEN));

        expect([first.status, second.status]).toStrictEqual([200, 200]);

        const issues = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getIssues, {}, ADMIN_TOKEN));
        const body = await issues.json<{ result: { issues: { count: number; culprit: string; title: string }[] } }>();

        expect(issues.status).toBe(200);

        const issue = body.result.issues.find((candidate) => candidate.culprit === "container:transcoder");

        expect(issue?.count).toBe(2);
    });

    it("folds a non-zero-exit `stop` (level info) into the getIssues stream", async () => {
        expect.assertions(3);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // A crash-loop's normal signal is a `stop` with a non-zero exit code —
        // NOT an `error`-level event. The lifecycle envelope carries it as
        // `level: "info"` with `(exit <n>)` in the message, so the handler must
        // treat the parsed non-zero exit code as a crash and append an error row.
        const crashStop = {
            container: "transcoder",
            event: "stop",
            instance: "do-a",
            level: "info",
            message: "runtime_signal (exit 137)",
            source: "lunora",
            ts: 1_700_000_000_000,
            type: "container",
        };

        const recorded = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordContainerEvent, { event: crashStop }, ADMIN_TOKEN));

        expect(recorded.status).toBe(200);

        const issues = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getIssues, {}, ADMIN_TOKEN));
        const body = await issues.json<{ result: { issues: { count: number; culprit: string }[] } }>();

        expect(issues.status).toBe(200);
        expect(body.result.issues.find((candidate) => candidate.culprit === "container:transcoder")?.count).toBe(1);
    });

    it("does NOT fold a clean `stop` (exit 0) into the getIssues stream", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const cleanStop = {
            container: "transcoder",
            event: "stop",
            instance: "do-a",
            level: "info",
            message: "graceful shutdown (exit 0)",
            source: "lunora",
            ts: 1_700_000_000_000,
            type: "container",
        };

        const recorded = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordContainerEvent, { event: cleanStop }, ADMIN_TOKEN));

        expect(recorded.status).toBe(200);

        const issues = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getIssues, {}, ADMIN_TOKEN));
        const body = await issues.json<{ result: { issues: { culprit: string }[] } }>();

        expect(body.result.issues.some((candidate) => candidate.culprit === "container:transcoder")).toBe(false);
    });

    it("rejects (400) a recordContainerEvent with a missing envelope", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordContainerEvent, { event: { event: "start" } }, ADMIN_TOKEN));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("admin-gates recordContainerEvent (403 without the bearer)", async () => {
        expect.assertions(1);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.recordContainerEvent, { event: { container: "c", event: "start" } }));

        expect(response.status).toBe(403);
    });
});

const usersSchema: SchemaLike = {
    tables: {
        users: {
            indexes: [],
            shape: {
                name: { kind: "string" },
                version: { kind: "number" },
            },
        },
    },
};

/** Bump every user's `version` by one — the migration the admin RPC runs. */
const bumpVersion: DataMigrationLike = {
    id: "bump-version",
    table: "users",
    up: (document) => {
        return { ...document, version: Number(document["version"] ?? 0) + 1 };
    },
};

const MIGRATIONS: Record<string, DataMigrationLike> = { [bumpVersion.id]: bumpVersion };

/**
 * Mirrors the codegen-generated subclass: overrides the base
 * `runShardDataMigration` hook to resolve a migration from a registry and drive
 * `runDataMigration` against a real-SQLite, schema-aware writer.
 */
class MigrationShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override runShardDataMigration(args: RunShardMigrationArgs): Promise<MigrationRunResult> {
        const migration = MIGRATIONS[args.id];

        if (!migration) {
            return Promise.reject(new LunoraError("MIGRATION_NOT_FOUND", `data migration "${args.id}" is not registered`, { status: 404 }));
        }

        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as SqlExec,
        });

        return runDataMigration({
            batchSize: args.batchSize,
            direction: args.direction,
            dryRun: args.dryRun,
            maxBatches: args.maxBatches,
            migration,
            sql: this.sql as SqlExec,
            writer,
        });
    }
}

describe("shardDO admin data migrations", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(async () => {
        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema);

        const writer: DatabaseWriterLike = createShardContextDatabase({ schema: usersSchema, sql: database.sql });

        for (let index = 1; index <= 3; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("users", { _id: `u${String(index)}`, name: `user ${String(index)}`, version: 0 });
        }

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const adminRequest = (functionPath: string, args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    const versions = (): unknown[] =>
        database.raw(`SELECT json_extract("__doc__", '$.version') AS version FROM "users" ORDER BY id`).map((row) => row["version"]);

    it("runs a registered migration and reports completed counts", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            result: { changed: 3, cursor: null, direction: "up", dryRun: false, id: "bump-version", processed: 3, status: "completed" },
        });
        expect(versions()).toEqual([1, 1, 1]);
    });

    it("records an audit entry after a successful runMigration", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getAuditLog, {}));
        const body = await response.json<{ result: { entries: { detail?: Record<string, unknown>; op: string; seq: number }[] } }>();

        expect(response.status).toBe(200);
        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]).toMatchObject({ detail: { changed: 3, processed: 3 }, op: "runMigration" });
    });

    it("dryRun previews counts without rewriting rows", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { dryRun: true, id: "bump-version" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ result: { changed: 3, dryRun: true, processed: 3, status: "completed" } });
        // The preview leaves rows untouched.
        expect(versions()).toEqual([0, 0, 0]);
    });

    it("reports persisted status after a run, and [] before any run", async () => {
        expect.assertions(3);

        const shard = new MigrationShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const before = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.migrationStatus, {}));

        await expect(before.json()).resolves.toEqual({ result: { migrations: [] } });

        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "bump-version" }));

        const after = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.migrationStatus, { id: "bump-version" }));
        const body = await after.json<{ result: { migrations: Record<string, unknown>[] } }>();

        expect(body.result.migrations).toHaveLength(1);
        expect(body.result.migrations[0]).toMatchObject({ changed: 3, direction: "up", id: "bump-version", processed: 3, status: "completed" });
    });

    it("rejects runMigration without an id (400)", async () => {
        expect.assertions(2);

        const shard = new MigrationShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, {}));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MIGRATION_ID_REQUIRED" } });
    });

    it("maps an unknown migration id to a 404 via the base hook default", async () => {
        expect.assertions(2);

        // AdminShard implements `handleRpc` but not `runShardDataMigration`, so
        // the base hook's not-found rejection surfaces through the admin path.
        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.runMigration, { id: "ghost" }));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MIGRATION_NOT_FOUND" } });
    });

    it("getMetrics returns a health snapshot with request/error counts", async () => {
        expect.assertions(5);

        const shard = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getMetrics, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { cache: unknown; errors: number; requests: number; shard: string } }>();

        expect(body.result.requests).toBe(2);
        expect(body.result.errors).toBe(1);
        expect(body.result.cache).toBeNull();
        expect(body.result.shard).toBeTypeOf("string");
    });

    it("getLogs returns the captured RPC errors, newest first", async () => {
        expect.assertions(3);

        // A failed dispatch is what the log buffer captures (path + message), so
        // a single boom call yields exactly one row; the successful call is not logged.
        const shard = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { entries: { functionPath?: string; level: string; message: string }[] } }>();

        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]).toMatchObject({ functionPath: "boom:explode", level: "error", message: "boom" });
    });

    it("getFunctionStats reports per-function call and error counts", async () => {
        expect.assertions(6);

        const shard = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // Two successes for one path, one failure for another — so the two paths
        // accumulate independently and the error path advances its error counter.
        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getFunctionStats, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{
            result: { functions: { calls: number; errors: number; lastErrorMessage: null | string; path: string }[]; sinceMs: number };
        }>();

        const byPath = new Map(body.result.functions.map((stat) => [stat.path, stat]));

        expect(body.result.functions).toHaveLength(2);
        expect(byPath.get("messages:list")).toMatchObject({ calls: 2, errors: 0, lastErrorMessage: null });
        expect(byPath.get("boom:explode")).toMatchObject({ calls: 1, errors: 1, lastErrorMessage: "boom" });
        expect(byPath.get("messages:list")?.lastErrorMessage).toBeNull();
        expect(body.result.sinceMs).toBeTypeOf("number");
    });

    it("getRequestLog records one durable entry per dispatch with the acting user, outcome and redacted args", async () => {
        expect.assertions(7);

        const shard = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // A user-attributed success and a failing dispatch, so the durable log
        // captures BOTH outcomes (unlike the error-only in-memory `getLogs`).
        const authedRequest = (functionPath: string): Request =>
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { password: "p@ssw0rd" }, functionPath }), // gitleaks:allow -- test fixture password, not a real secret
                headers: { "content-type": "application/json", "x-lunora-userid": "u1" },
                method: "POST",
            });

        await shard.fetch(authedRequest("messages:list"));
        await shard.fetch(userRequest("boom:explode"));

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getRequestLog, {}));

        expect(response.status).toBe(200);

        const body = await response.json<{
            result: { entries: { functionPath: string; outcome: string; redactedArgs?: Record<string, unknown>; userId?: string }[] };
        }>();

        // Newest first: the boom error precedes the messages:list success.
        expect(body.result.entries).toHaveLength(2);
        expect(body.result.entries[0]).toMatchObject({ functionPath: "boom:explode", outcome: "error" });
        expect(body.result.entries[1]).toMatchObject({ functionPath: "messages:list", outcome: "ok", userId: "u1" });

        // Args are redacted by default — the raw secret never reaches the log, but the shape survives.
        const loggedArgs = body.result.entries[1]!.redactedArgs!;

        expect(Object.keys(loggedArgs)).toEqual(["password"]);
        expect(loggedArgs.password).not.toBe("p@ssw0rd"); // gitleaks:allow -- test fixture password, not a real secret

        // And the correlated filters narrow on those fields.
        const filtered = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getRequestLog, { outcome: "error" }));
        const filteredBody = await filtered.json<{ result: { entries: { functionPath: string }[] } }>();

        expect(filteredBody.result.entries.map((entry) => entry.functionPath)).toStrictEqual(["boom:explode"]);
    });

    it("samples out successful dispatches at rate 0 but always records errors", async () => {
        expect.assertions(2);

        const shard = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_REQUEST_LOG_SAMPLE: "0" });

        await shard.fetch(userRequest("messages:list")); // ok → sampled out
        await shard.fetch(userRequest("messages:get")); // ok → sampled out
        await shard.fetch(userRequest("boom:explode")); // error → always recorded

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getRequestLog, {}));
        const body = await response.json<{ result: { entries: { functionPath: string; outcome: string }[] } }>();

        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]).toMatchObject({ functionPath: "boom:explode", outcome: "error" });
    });

    it("captures raw args in a dev environment (LUNORA PII dev escape hatch)", async () => {
        expect.assertions(1);

        const shard = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, ENVIRONMENT: "development" });

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { password: "p@ssw0rd" }, functionPath: "messages:list" }), // gitleaks:allow -- test fixture password, not a real secret
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getRequestLog, {}));
        const body = await response.json<{ result: { entries: { redactedArgs?: Record<string, unknown> }[] } }>();

        // Dev → raw capture: the value is NOT redacted.
        expect(body.result.entries[0]!.redactedArgs).toStrictEqual({ password: "p@ssw0rd" }); // gitleaks:allow -- test fixture password, not a real secret
    });

    /**
     * Safely parse a JSON string to a plain object.
     * @returns the parsed object, or `undefined` when parsing fails or the value is not a plain object
     */
    const tryParseJson = (raw: unknown): Record<string, unknown> | undefined => {
        try {
            const parsed = JSON.parse(String(raw)) as unknown;
            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
        } catch {
            return undefined;
        }
    };
    const lunoraRequestEvents = (spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
        spy.mock.calls
            .map((call): Record<string, unknown> | undefined => tryParseJson(call[0]))
            .filter((event): event is Record<string, unknown> => event?.source === "lunora" && event.type === "request");

    it("always streams an error dispatch to console.error even without the emit flag", async () => {
        expect.assertions(2);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const shard = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(userRequest("boom:explode"));

        const events = lunoraRequestEvents(error);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ function: "boom:explode", outcome: "error" });

        vi.restoreAllMocks();
    });

    it("does NOT stream a successful dispatch to console unless LUNORA_REQUEST_LOG_EMIT is set", async () => {
        expect.assertions(2);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        const quiet = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await quiet.fetch(userRequest("messages:list"));

        expect(lunoraRequestEvents(log)).toHaveLength(0);

        const loud = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_REQUEST_LOG_EMIT: "1" });

        await loud.fetch(userRequest("messages:list"));

        expect(lunoraRequestEvents(log)).toHaveLength(1);

        vi.restoreAllMocks();
    });

    it("streams a successful dispatch by default in a dev environment (WORKER_ENV)", async () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        // No LUNORA_REQUEST_LOG_EMIT — the dev env (set by `lunora dev` / the Vite plugin) flips it on.
        const dev = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, WORKER_ENV: "development" });

        await dev.fetch(userRequest("messages:list"));

        expect(lunoraRequestEvents(log)).toHaveLength(1);

        vi.restoreAllMocks();
    });

    it("lets an explicit request-log emit of `false` silence summaries even in dev", async () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const dev = new CountingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_REQUEST_LOG_EMIT: "false", WORKER_ENV: "development" });

        await dev.fetch(userRequest("messages:list"));

        expect(lunoraRequestEvents(log)).toHaveLength(0);

        vi.restoreAllMocks();
    });

    it("recordUserLog buffers the line, emits a console event, and forwards to the sink", async () => {
        expect.assertions(5);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const seen: { args: unknown[]; functionPath: string; level: string; message: string }[] = [];
        const shard = new LoggingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // `(string, object)` is the structured form: message + a fields bag.
        shard.log("messages:list", "info", ["loaded", { count: 3 }], { onLog: (event) => seen.push(event) });

        // Forwarded to the programmatic sink, args un-redacted, attributed, with
        // the parsed structured `fields` and (absent here) trace-correlation ids.
        expect(seen).toStrictEqual([
            {
                args: ["loaded", { count: 3 }],
                fields: { count: 3 },
                functionPath: "messages:list",
                level: "info",
                message: "loaded",
                shardKey: undefined,
                spanId: undefined,
                traceId: undefined,
                ts: expect.any(Number),
                userId: undefined,
            },
        ]);

        // Structured console event for the dev terminal / Workers Logs — carries
        // the message and the structured fields (but not the raw args).
        const events = log.mock.calls
            .map((call): Record<string, unknown> | undefined => tryParseJson(call[0]))
            .filter((event): event is Record<string, unknown> => event?.source === "lunora" && event.type === "log");

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ fields: { count: 3 }, function: "messages:list", level: "info", message: "loaded" });

        vi.restoreAllMocks();

        // Buffered for the studio Logs panel via the admin getLogs RPC.
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}));
        const body = await response.json<{ result: { entries: { functionPath: string; level: string; message: string }[] } }>();

        expect(body.result.entries).toHaveLength(1);
        // The buffer entry (and thus the studio Logs panel) carries the structured fields.
        expect(body.result.entries[0]).toMatchObject({ fields: { count: 3 }, functionPath: "messages:list", level: "info", message: "loaded" });
    });

    it("threads a waitUntil context to the log sink so a durable sink can outlive the response", async () => {
        expect.assertions(1);

        vi.spyOn(console, "log").mockImplementation(() => {});
        let hasWaitUntilSlot = false;
        const shard = new LoggingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        shard.log("a:b", "info", ["hi"], {
            onLog: (_event, context) => {
                hasWaitUntilSlot = context !== undefined && "waitUntil" in context;
            },
        });

        expect(hasWaitUntilSlot).toBe(true);

        vi.restoreAllMocks();
    });

    it("treats console-style varargs as a rendered message with no structured fields", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => {});
        const seen: { fields?: Record<string, unknown>; message: string }[] = [];
        const shard = new LoggingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // Three args (not the `(string, object)` structured shape) → console-style.
        shard.log("a:b", "info", ["state", { count: 3 }, "extra"], { onLog: (event) => seen.push(event) });

        expect(seen[0]!.message).toBe('state {"count":3} extra');
        expect(seen[0]!.fields).toBeUndefined();

        vi.restoreAllMocks();
    });

    it("treats an Error (or other class instance) second arg as console-style, not structured fields", async () => {
        expect.assertions(2);

        vi.spyOn(console, "error").mockImplementation(() => {});
        const seen: { args: unknown[]; fields?: Record<string, unknown> }[] = [];
        const shard = new LoggingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const error = new Error("boom");

        // The ubiquitous `ctx.log.error("failed", err)` idiom: `err` is NOT a
        // plain fields bag, so it must stay console-style — not be misrouted to
        // the structured branch (where a field-less Error would be dropped).
        shard.log("a:b", "error", ["failed", error], { onLog: (event) => seen.push(event) });

        expect(seen[0]!.fields).toBeUndefined();
        // The raw Error survives on `args` for an in-process sink to inspect.
        expect(seen[0]!.args).toStrictEqual(["failed", error]);

        vi.restoreAllMocks();
    });

    it("with(fields) stamps bound fields onto every line, per-call fields winning on a clash", async () => {
        expect.assertions(3);

        vi.spyOn(console, "log").mockImplementation(() => {});
        const seen: { fields?: Record<string, unknown>; level: string; message: string }[] = [];
        const shard = new LoggingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const logger = shard.logger("orders:place", { onLog: (event) => seen.push(event) });
        const bound = logger.with({ orderId: "o-1", step: "start" });

        bound.info("charging");
        bound.fatal("charge failed", { code: "CARD_DECLINED", step: "charge" });

        // Bound fields flow onto a fields-free call.
        expect(seen[0]).toMatchObject({ fields: { orderId: "o-1", step: "start" }, level: "info", message: "charging" });
        // Per-call fields merge over bound; `step` is overridden, `code` added.
        expect(seen[1]).toMatchObject({ fields: { code: "CARD_DECLINED", orderId: "o-1", step: "charge" }, level: "fatal", message: "charge failed" });
        // The new severities are carried through verbatim.
        expect(seen[1]!.level).toBe("fatal");

        vi.restoreAllMocks();
    });

    it("normalizes fields to JSON-safe primitives so a bigint/circular value can't break getLogs", async () => {
        expect.assertions(3);

        vi.spyOn(console, "log").mockImplementation(() => {});
        const seen: { fields?: Record<string, unknown> }[] = [];
        const shard = new LoggingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const circular: Record<string, unknown> = { name: "loop" };
        circular.self = circular;

        shard.log("pay:charge", "info", ["charged", { amount: 10n, circular }], { onLog: (event) => seen.push(event) });

        // `bigint` → its `String()` form, a circular object → `"[object Object]"`; both JSON-safe.
        expect(seen[0]!.fields).toStrictEqual({ amount: "10", circular: "[object Object]" });

        // The whole buffer serializes through `getLogs` without throwing.
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}));
        const body = await response.json<{ result: { entries: { fields?: Record<string, unknown> }[] } }>();

        expect(body.result.entries).toHaveLength(1);
        expect(body.result.entries[0]!.fields).toStrictEqual({ amount: "10", circular: "[object Object]" });

        vi.restoreAllMocks();
    });

    it("drops an empty fields object and snapshots fields so a later mutation can't alter the logged line", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => {});
        const seen: { fields?: Record<string, unknown> }[] = [];
        const shard = new LoggingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // An empty object carries no structured fields onto the line.
        shard.log("a:b", "info", ["hi", {}], { onLog: (event) => seen.push(event) });

        expect(seen[0]!.fields).toBeUndefined();

        // Mutating the caller's object after the call does not reach the captured copy.
        const bag: Record<string, unknown> = { step: "start" };

        shard.log("a:b", "info", ["go", bag], { onLog: (event) => seen.push(event) });
        bag.step = "mutated";

        expect(seen[1]!.fields).toStrictEqual({ step: "start" });

        vi.restoreAllMocks();
    });

    it("keeps the full severity ramp on the studio buffer instead of folding it", async () => {
        expect.assertions(1);

        vi.spyOn(console, "debug").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        const shard = new LoggingShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // `log`/`trace`/`fatal` used to fold onto `info`/`debug`/`error`, which made
        // the three tiers unreadable in the Studio Logs panel. Each is now buffered
        // at the level the caller actually logged at.
        shard.log("a:b", "log", ["hi"]);
        shard.log("a:b", "trace", ["deep"]);
        shard.log("a:b", "fatal", ["boom"]);
        vi.restoreAllMocks();

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}));
        const body = await response.json<{ result: { entries: { level: string }[] } }>();

        // `entries()` is newest-first, so the buffer reads back in reverse order.
        expect(body.result.entries.map((entry) => entry.level)).toStrictEqual(["fatal", "trace", "log"]);
    });
});

/**
 * Drives the `__lunora_admin__:writeRow` op through a real schema-aware writer,
 * mirroring what the codegen-generated subclass emits. Proves single-row
 * insert/patch/replace/delete land in SQLite via the admin path.
 */
class EditableShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async runShardWrite(args: RunShardWriteArgs): Promise<RunShardWriteResult> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as SqlExec,
        });

        if (args.op === "insert") {
            return { id: await writer.insert(args.table, args.doc ?? {}), op: "insert" };
        }

        if (args.op === "delete") {
            await writer.delete(args.id ?? "");

            return { id: args.id ?? null, op: "delete" };
        }

        if (args.op === "replace") {
            await writer.replace(args.id ?? "", args.doc ?? {});

            return { id: args.id ?? null, op: "replace" };
        }

        await writer.patch(args.id ?? "", args.doc ?? {});

        return { id: args.id ?? null, op: "patch" };
    }
}

describe("shardDO admin row writes", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const writeRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.writeRow }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    const rowCount = (): number => Number(database.raw(`SELECT COUNT(*) AS c FROM "users"`)[0]?.["c"] ?? 0);

    it("inserts a row and returns its assigned id", async () => {
        expect.assertions(4);

        const shard = new EditableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "Ada", version: 1 }, op: "insert", table: "users" }));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: RunShardWriteResult }>();

        expect(body.result.op).toBe("insert");

        expect(typeof body.result.id).toBe("string");

        expect(rowCount()).toBe(1);
    });

    it("patches an existing row", async () => {
        expect.assertions(2);

        const seed = createShardContextDatabase({ schema: usersSchema, sql: database.sql });
        const id = await seed.insert("users", { name: "old", version: 1 });

        const shard = new EditableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "new" }, id, op: "patch", table: "users" }));

        expect(response.status).toBe(200);

        const name = database.raw(`SELECT json_extract("__doc__", '$.name') AS name FROM "users" WHERE id = ?`, id)[0]?.["name"];

        expect(name).toBe("new");
    });

    it("deletes a row", async () => {
        expect.assertions(2);

        const seed = createShardContextDatabase({ schema: usersSchema, sql: database.sql });
        const id = await seed.insert("users", { name: "doomed", version: 1 });

        const shard = new EditableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ id, op: "delete", table: "users" }));

        expect(response.status).toBe(200);
        expect(rowCount()).toBe(0);
    });

    it("rejects an unknown op (400)", async () => {
        expect.assertions(1);

        const shard = new EditableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: {}, op: "bogus", table: "users" }));

        expect(response.status).toBe(400);
    });

    it("requires an id for patch (400)", async () => {
        expect.assertions(1);

        const shard = new EditableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "x" }, op: "patch", table: "users" }));

        expect(response.status).toBe(400);
    });

    it("base ShardDO rejects writeRow as an unknown table (no override)", async () => {
        expect.assertions(2);

        class BareShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; the admin-write path never dispatches an RPC
            public override async handleRpc(): Promise<unknown> {
                return null;
            }
        }

        const shard = new BareShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(writeRequest({ doc: { name: "x" }, op: "insert", table: "users" }));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });
});

/** A global leaderboard rank index (`partitionBy: []`) on the `messages` table. */
const rankByScoreDesc: RankIndexDefinitionLike = {
    name: "leaderboard",
    on: "messages",
    sortBy: [{ direction: "desc", field: "score" }],
};

const messagesRankSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [],
            rankIndexes: [rankByScoreDesc],
            shape: {
                channelId: { kind: "string" },
                score: { kind: "number" },
            },
        },
    },
};

/**
 * Drives the `__lunora_admin__:rankBefore` op through a real schema-aware
 * writer, mirroring the codegen-generated subclass. Proves the cross-shard
 * rank's per-shard `{before, total}` count is served over the admin path.
 */
class RankableShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async runShardRankBefore(args: RunShardRankBeforeArgs): Promise<{ before: number; total: number }> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: messagesRankSchema,
            sql: this.sql as SqlExec,
        });

        return writer.rankBefore!(args.table, args.index, {
            partitionKey: args.partitionKey,
            rowId: args.rowId,
            sortValues: args.sortValues,
        });
    }

    protected override async runShardRankPage(args: RunShardRankPageArgs): Promise<ShardRankPageResult> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: messagesRankSchema,
            sql: this.sql as SqlExec,
        });

        return writer.rankPageRows!(args.table, args.index, {
            after: args.after,
            cursor: args.cursor,
            partitionKey: args.partitionKey,
            take: args.take,
        });
    }
}

describe("shardDO admin rankBefore", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, messagesRankSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const rankBeforeRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.rankBefore }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    it("counts strictly-before rows for an explicit key on this shard", async () => {
        expect.assertions(2);

        // This shard owns a disjoint slice of the global leaderboard partition.
        const seed = createShardContextDatabase({ schema: messagesRankSchema, sql: database.sql });

        await seed.insert("messages", { _id: "m1", channelId: "c1", score: 90 }, { allowExplicitId: true });
        await seed.insert("messages", { _id: "m2", channelId: "c1", score: 70 }, { allowExplicitId: true });
        await seed.insert("messages", { _id: "m3", channelId: "c1", score: 20 }, { allowExplicitId: true });

        const shard = new RankableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // Rank a foreign row scored 75: desc order → m1(90) is strictly before
        // it, m2(70)/m3(20) are after. before=1, total=3 (this shard's rows).
        const key = rankKeyFromDoc(rankByScoreDesc, { _id: "x1", channelId: "c9", score: 75 });
        const response = await shard.fetch(rankBeforeRequest({ index: "leaderboard", table: "messages", ...key }));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { before: number; total: number } }>();

        expect(body.result).toEqual({ before: 1, total: 3 });
    });

    it("rejects a non-array sortValues (400)", async () => {
        expect.assertions(1);

        const shard = new RankableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(rankBeforeRequest({ index: "leaderboard", partitionKey: "", rowId: "x1", sortValues: 5, table: "messages" }));

        expect(response.status).toBe(400);
    });

    it("base ShardDO rejects rankBefore as not implemented (no override)", async () => {
        expect.assertions(2);

        class BareShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; the admin-rank path never dispatches an RPC
            public override async handleRpc(): Promise<unknown> {
                return null;
            }
        }

        const shard = new BareShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(rankBeforeRequest({ index: "leaderboard", partitionKey: "", rowId: "x1", sortValues: [75], table: "messages" }));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_IMPLEMENTED" } });
    });
});

describe("shardDO admin rankPage", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, messagesRankSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const rankPageRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.rankPage }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    it("returns this shard's local ranked slice with correctly-keyed rows + hasMore", async () => {
        expect.assertions(4);

        const seed = createShardContextDatabase({ schema: messagesRankSchema, sql: database.sql });

        await seed.insert("messages", { _id: "m1", channelId: "c1", score: 90 }, { allowExplicitId: true });
        await seed.insert("messages", { _id: "m2", channelId: "c1", score: 70 }, { allowExplicitId: true });
        await seed.insert("messages", { _id: "m3", channelId: "c1", score: 20 }, { allowExplicitId: true });

        const shard = new RankableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(rankPageRequest({ index: "leaderboard", table: "messages", take: 2 }));

        expect(response.status).toBe(200);

        // The shape the coordinator's `readRankPageResult` parses (under `result`): { hasMore, rows: [{doc, key}] }.
        const body = await response.json<{ result: ShardRankPageResult }>();

        expect(body.result.hasMore).toBe(true);
        expect(body.result.rows.map((row) => row.doc["_id"])).toEqual(["m1", "m2"]);
        // Keys are byte-compatible with rankKeyFromDoc — what the cross-shard comparator orders on.
        expect(body.result.rows[0]?.key).toEqual(rankKeyFromDoc(rankByScoreDesc, { _id: "m1", channelId: "c1", score: 90 }));
    });

    it("resumes strictly-after the structured `after` key the coordinator forwards", async () => {
        expect.assertions(1);

        const seed = createShardContextDatabase({ schema: messagesRankSchema, sql: database.sql });

        await seed.insert("messages", { _id: "m1", channelId: "c1", score: 90 }, { allowExplicitId: true });
        await seed.insert("messages", { _id: "m2", channelId: "c1", score: 70 }, { allowExplicitId: true });
        await seed.insert("messages", { _id: "m3", channelId: "c1", score: 20 }, { allowExplicitId: true });

        const shard = new RankableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        // Resume after m1 (the highest score) → the next page is m2 then m3.
        const after = rankKeyFromDoc(rankByScoreDesc, { _id: "m1", channelId: "c1", score: 90 });
        const response = await shard.fetch(rankPageRequest({ after, index: "leaderboard", table: "messages", take: 10 }));
        const body = await response.json<{ result: ShardRankPageResult }>();

        expect(body.result.rows.map((row) => row.doc["_id"])).toEqual(["m2", "m3"]);
    });

    it("400s on a malformed `after` key (missing rowId)", async () => {
        expect.assertions(1);

        const shard = new RankableShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(rankPageRequest({ after: { partitionKey: "", sortValues: [1] }, index: "leaderboard", table: "messages" }));

        expect(response.status).toBe(400);
    });

    it("base ShardDO rejects rankPage as not implemented (no override)", async () => {
        expect.assertions(2);

        class BareShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; the admin-rank path never dispatches an RPC
            public override async handleRpc(): Promise<unknown> {
                return null;
            }
        }

        const shard = new BareShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(rankPageRequest({ index: "leaderboard", table: "messages" }));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_IMPLEMENTED" } });
    });
});

describe("shardDO admin cdcSync", () => {
    let database: ReturnType<typeof createSqliteExec>;

    const stateFor = (sql: unknown): ShardDOState => {
        return {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: sql as ShardDOState["storage"]["sql"] },
        };
    };

    const cdcRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.cdcSync }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    afterEach(() => {
        database.close();
    });

    it("pages this shard's changelog past sinceSeq", async () => {
        expect.assertions(3);

        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema, { cdc: true });

        const writer = createShardContextDatabase({ cdc: true, schema: usersSchema, sql: database.sql });

        await writer.insert("users", { _id: "u_1", name: "Ada", version: 1 }, { allowExplicitId: true });
        await writer.patch("u_1", { name: "Ada Lovelace" });

        const shard = new AdminShard(stateFor(database.sql), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(cdcRequest({ sinceSeq: 0 }));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { changes: { op: string }[]; cursor: number } }>();

        expect(body.result.changes.map((change) => change.op)).toStrictEqual(["insert", "update"]);
        expect(body.result.cursor).toBe(2);
    });

    it("returns an empty page that leaves the cursor untouched when the shard has no changelog", async () => {
        expect.assertions(2);

        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema); // CDC disabled — no __cdc_log table.

        const shard = new AdminShard(stateFor(database.sql), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(cdcRequest({ sinceSeq: 7 }));
        const body = await response.json<{ result: { changes: unknown[]; cursor: number } }>();

        expect(body.result.changes).toStrictEqual([]);
        expect(body.result.cursor).toBe(7);
    });
});

/** Mirrors the codegen subclass: overrides runShardApplyCdc with a real writer. */
class ApplyShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async runShardApplyCdc(args: RunShardApplyCdcArgs): Promise<RunShardApplyCdcResult> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: usersSchema,
            sql: this.sql as SqlExec,
        });

        await applyCdcChanges(writer, args.changes);

        return { applied: args.changes.length };
    }
}

describe("shardDO admin applyCdc", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, usersSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const applyRequest = (changes: unknown[]): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: { changes }, functionPath: ADMIN_FUNCTIONS.applyCdc }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    const rowCount = (): number => Number(database.raw(`SELECT COUNT(*) AS c FROM "users"`)[0]?.["c"] ?? 0);

    it("replays an insert + a delete through the writer", async () => {
        expect.assertions(3);

        const shard = new ApplyShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const seed = createShardContextDatabase({ schema: usersSchema, sql: database.sql });
        const doomedId = await seed.insert("users", { name: "doomed", version: 1 });

        const response = await shard.fetch(
            applyRequest([
                { doc: { _id: "u_keep", name: "Ada", version: 1 }, id: "u_keep", op: "insert", table: "users" },
                { id: doomedId, op: "delete", table: "users" },
            ]),
        );

        expect(response.status).toBe(200);

        const body = await response.json<{ result: RunShardApplyCdcResult }>();

        expect(body.result.applied).toBe(2);
        // The seeded row was deleted and the replayed row inserted — net one row.
        expect(rowCount()).toBe(1);
    });

    it("rejects a malformed changes payload (400)", async () => {
        expect.assertions(1);

        const shard = new ApplyShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(applyRequest([{ id: "x", op: "bogus", table: "users" }]));

        expect(response.status).toBe(400);
    });
});

/** Per-project count aggregate on `todos`, so a writer-routed delete must step the counter shadow table down. */
const todosByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

/** A within-project rank on `todos`, so a writer-routed delete must also keep the rank shadow table consistent. */
const todosRankByDone: RankIndexDefinitionLike = {
    name: "byDone",
    on: "todos",
    partitionBy: ["projectId"],
    sortBy: [{ direction: "asc", field: "_creationTime" }],
};

const todosSchema: SchemaLike = {
    tables: {
        todos: {
            aggregateIndexes: [todosByProject],
            indexes: [],
            rankIndexes: [todosRankByDone],
            shape: {
                done: { kind: "boolean" },
                projectId: { kind: "string" },
                title: { kind: "string" },
            },
        },
    },
};

/**
 * Drives the `__lunora_admin__:deleteRows` / `__lunora_admin__:clearTable` ops
 * through a real schema-aware writer, mirroring the codegen-generated subclass'
 * `deleteRowThroughWriter` override. The base `runShardBulkDelete` owns the
 * bounded id-collection loop; this only supplies the per-row writer delete, so
 * the FTS / aggregate / rank shadow tables stay in sync exactly like a single
 * `writeRow` delete.
 */
class BulkDeleteShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async deleteRowThroughWriter(_table: string, id: string): Promise<void> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: todosSchema,
            sql: this.sql as SqlExec,
        });

        await writer.delete(id);
    }
}

describe("shardDO admin bulk delete", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        runShardMigrations(database.sql, todosSchema);

        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const bulkRequest = (functionPath: string, args: Record<string, unknown>): Request => {
        const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };

        return new Request("https://shard.internal/rpc", { body: JSON.stringify({ args, functionPath }), headers, method: "POST" });
    };

    const rowCount = (): number => Number(database.raw(`SELECT COUNT(*) AS c FROM "todos"`)[0]?.["c"] ?? 0);

    /** Seed `count` todos in the given project, returning the writer used (its reads hit the shadow tables). */
    const seedProject = async (writer: DatabaseWriterLike, project: string, count: number): Promise<void> => {
        for (let index = 0; index < count; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes
            await writer.insert("todos", { done: false, projectId: project, title: `t${index.toString()}` }); // gitleaks:allow -- column name, not a secret
        }
    };

    it("deletes only the rows matching a filter, leaving the rest", async () => {
        expect.assertions(4);

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 3);
        await seedProject(seed, "p2", 2);

        const shard = new BulkDeleteShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(
            bulkRequest(ADMIN_FUNCTIONS.deleteRows, { filters: [{ column: "projectId", operator: "eq", value: "p1" }], table: "todos" }),
        );

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { deleted: number; hasMore: boolean } }>();

        expect(body.result).toEqual({ deleted: 3, hasMore: false });
        // p1's three rows are gone; p2's two survive.
        expect(rowCount()).toBe(2);
        await expect(seed.count("todos", { projectId: "p2" })).resolves.toBe(2);
    });

    it("keeps the aggregate and rank shadow tables consistent after a bulk delete", async () => {
        expect.assertions(3);

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 4);
        await seedProject(seed, "p2", 1);

        const shard = new BulkDeleteShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, { filters: [{ column: "projectId", operator: "eq", value: "p1" }], table: "todos" }));

        // The count aggregate reads its counter shadow table — only correct if
        // every delete went THROUGH the writer (not raw SQL).
        await expect(seed.count("todos", { projectId: "p1" })).resolves.toBe(0);
        await expect(seed.count("todos", { projectId: "p2" })).resolves.toBe(1);

        // The rank shadow table for p1 is now empty: ranking the surviving p2
        // row returns position 0 within its own partition, proving p1's rank
        // rows were cleaned up rather than orphaned.
        const survivor = database.raw(`SELECT id FROM "todos" WHERE json_extract("__doc__", '$.projectId') = 'p2' LIMIT 1`)[0]?.["id"] as string;
        const key = rankKeyFromDoc(todosRankByDone, { _id: survivor, projectId: "p2" });

        await expect(seed.rankBefore!("todos", "byDone", { partitionKey: key.partitionKey, rowId: survivor, sortValues: key.sortValues })).resolves.toEqual({
            before: 0,
            total: 1,
        });
    });

    it("is bounded: caps deletes at `limit` and reports hasMore", async () => {
        expect.assertions(3);

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 5);

        const shard = new BulkDeleteShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, { limit: 2, table: "todos" }));
        const body = await response.json<{ result: { deleted: number; hasMore: boolean } }>();

        expect(body.result.deleted).toBe(2);
        expect(body.result.hasMore).toBe(true);
        // Only the capped batch was removed; the rest remain for the next loop.
        expect(rowCount()).toBe(3);
    });

    it("clearTable empties the whole table through the writer", async () => {
        expect.assertions(3);

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 3);
        await seedProject(seed, "p2", 2);

        const shard = new BulkDeleteShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.clearTable, { table: "todos" }));
        const body = await response.json<{ result: { deleted: number; hasMore: boolean } }>();

        expect(body.result).toEqual({ deleted: 5, hasMore: false });
        expect(rowCount()).toBe(0);
        // The counter shadow table dropped to zero for both projects.
        await expect(seed.count("todos", { projectId: "p1" })).resolves.toBe(0);
    });

    it("rejects deleteRows without a table (400)", async () => {
        expect.assertions(1);

        const shard = new BulkDeleteShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, {}));

        expect(response.status).toBe(400);
    });

    it("maps an unknown table to a 404", async () => {
        expect.assertions(1);

        const shard = new BulkDeleteShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, { table: "nope" }));

        expect(response.status).toBe(404);
    });

    it("base ShardDO rejects deleteRows as an unknown table (no override)", async () => {
        expect.assertions(2);

        class BareShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; the admin bulk-delete path never dispatches an RPC
            public override async handleRpc(): Promise<unknown> {
                return null;
            }
        }

        const seed = createShardContextDatabase({ schema: todosSchema, sql: database.sql });

        await seedProject(seed, "p1", 1);

        const shard = new BareShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(bulkRequest(ADMIN_FUNCTIONS.deleteRows, { table: "todos" }));

        // The id collection succeeds, but the base `deleteRowThroughWriter`
        // stub rejects the first row as an unknown table.
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "UNKNOWN_TABLE" } });
    });
});
