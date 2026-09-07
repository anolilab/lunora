/**
 * Cross-shard query coordinator.
 *
 * Lights up when a `.shardBy(...)` table needs an aggregate read — `list`,
 * `search`, `count`, or a "look this up everywhere" call. The coordinator:
 *
 * 1. Asks a {@link ShardRegistry} which shard keys are live for the table.
 * 2. Fans the RPC out to each shard via the same DO namespace the
 * single-shard path uses (bounded by `maxConcurrency`).
 * 3. Applies a per-shard timeout so one slow shard cannot stall the
 * aggregate response — slow shards return a {@link ShardError} and the
 * merge step decides whether that's fatal.
 * 4. Merges results via a {@link MergeStrategy} — `concat`, `sum`,
 * `topK`, or `first`. All four are serializable from the wire so the
 * client (or codegen) can describe the merge without sending closures.
 *
 * The DO-storage-backed routing table the plan describes is hidden behind
 * the {@link ShardRegistry} interface — we ship a static implementation
 * (`createStaticShardRegistry`) here and leave the DO/KV-backed registry
 * for a follow-up once codegen opts schemas into cross-shard call sites.
 */
import { toErrorBody } from "@lunora/errors";
import type { RankDirection as RankPageDirection, RankPageRow, RankPageRowKey as RankPageKey, ShardRankPageResult } from "@lunora/shard-engine";

import { fromBase64, toBase64 } from "../../../shared/base64";
import { LunoraError } from "./errors";
import type { ShardNamespaceInput } from "./resolve-shard";
import { resolveShard } from "./resolve-shard";

/**
 * Source of "which shard keys exist for a given table right now". Returning
 * an empty array is valid — the coordinator will respond with the merge
 * strategy's identity (empty array for `concat`, `0` for `sum`, etc.).
 */
interface ShardRegistry {
    listShardKeys: (table: string) => Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
}

/**
 * Static-map implementation. Useful for tests and for small deployments
 * where shard keys are known up front (e.g. a fixed set of channel IDs).
 */
const createStaticShardRegistry = (table_to_keys: Readonly<Record<string, ReadonlyArray<string>>>): ShardRegistry => {
    return {
        listShardKeys(table) {
            return table_to_keys[table] ?? [];
        },
    };
};

/**
 * Wire-serializable merge strategy. `topK.by` is a field name on the row
 * (the runtime looks it up with a string key), not a closure.
 *
 * Aggregate-friendly variants for cross-shard `count` / `aggregate` /
 * `groupBy` fan-outs:
 *
 * - `sum` — `count(*)`, `aggregate({ op: "sum" })` (sums numeric per-shard payloads).
 * - `max` — `aggregate({ op: "max" })`.
 * - `min` — `aggregate({ op: "min" })`.
 * - `groupBy` — per-shard `GroupByEntry[]` payloads, reduced into one
 * entry per distinct key tuple. `op` controls how values combine across
 * shards: `sum` (default — works for `COUNT(*)` and `SUM`), `max`, `min`.
 *
 * `avg` is intentionally absent in v1 — a correct cross-shard average
 * requires shipping `(sum, count)` per shard, not the post-shard mean.
 * Use two separate fan-outs (`sum` + `count`) and divide in the caller.
 *
 * `rank` — cross-shard `rank()` over a partition that spans shards (e.g. a
 * global leaderboard `.shardBy("userId")` with `rankIndex(partitionBy: [])`).
 * Each shard's `__lunora_admin__:rankBefore` returns `{before, total}` (its
 * local rows strictly-before the explicit key, plus its local partition
 * total); the merge sums them into `{position: Σbefore + 1, total: Σtotal}` —
 * the 1-based global position and global partition size.
 */
type MergeStrategy =
    | { kind: "concat" }
    | { by: string; direction?: "asc" | "desc"; k: number; kind: "topK" }
    | { kind: "first" }
    | { kind: "max" }
    | { kind: "min" }
    | { kind: "rank" }
    | { kind: "sum" }
    | { kind: "groupBy"; op?: "max" | "min" | "sum" };

interface FanOutSpec {
    merge: MergeStrategy;
    /** Table whose shard keys drive the fan-out. */
    table: string;
}

/**
 * Per-shard failure surfaced in the aggregate response's `errors` field. We
 * never throw out of `fanOut` — slow/failed shards are *data*, not an
 * exception, so callers can decide whether to retry or surface a partial
 * UI.
 */
interface ShardError {
    /**
     * Machine-readable failure code, from the same `toErrorBody` shaping every
     * other error leaving this runtime goes through: a shard's own
     * `LunoraError` code when it had one, `SHARD_TIMEOUT` / `SHARD_HTTP_ERROR`
     * for the transport failures this coordinator detects itself, and `INTERNAL`
     * for anything else. Callers branch on this rather than on `message`.
     */
    code: string;

    /**
     * Human-readable; tests assert on `.includes("timeout")` and similar. Shaped
     * by `toErrorBody`, so an internal-coded or non-`LunoraError` throw is
     * redacted here exactly as it would be on the single-shard path — the
     * fan-out envelope is `Response.json`-ed straight to the caller, and a raw
     * `error.message` from a shard is platform detail that must not ride out.
     */
    message: string;
    shardKey: string;
    /** Set when the per-shard timeout fired. */
    timedOut: boolean;
}

interface FanOutResult<T = unknown> {
    /** Merged value — type depends on the merge strategy. */
    data: T;
    errors: ReadonlyArray<ShardError>;
    /** Shards that failed or timed out. */
    failed: number;
    /** Shards that returned successfully. */
    ok: number;
}

interface QueryCoordinatorOptions {
    /**
     * Maximum number of shard RPCs to issue in parallel. Defaults to 16 —
     * keeps the 30-second Worker CPU budget healthy when fanning out to
     * dozens of shards and avoids stampeding the DO namespace.
     */
    maxConcurrency?: number;

    /**
     * Hard per-shard timeout in milliseconds. Defaults to 5000; a slow
     * shard surfaces in `errors[]` rather than stalling the aggregate.
     */
    perShardTimeoutMs?: number;
    /** Required — drives which shards to fan out to. */
    registry: ShardRegistry;
}

/**
 * Shard a fan-out falls back to when registry discovery finds nothing — normally
 * the worker's `"__root__"` — or `null` to deliberately keep an empty discovery
 * as an empty fan-out.
 *
 * Required on every request that has it, with no default, on purpose. Discovery
 * is registry-driven and a registry only knows the keys an app registers for its
 * `.shardBy(...)` tables, so on a plain root-DO app it comes back empty and a
 * fan-out that reads that as "nothing to do" reports success having touched
 * nothing: an export streamed an empty NDJSON backup, a migration reported
 * `completed` with `processed: 0`. Fan-outs inherited that bug by simply not
 * passing the field, so omission is no longer expressible — say `null` when you
 * mean it. See {@link withDefaultShard}.
 */
type DefaultShardKey = string | null;

interface FanOutRequest {
    args?: Record<string, unknown>;
    fanOut: FanOutSpec;
    functionPath: string;
    /** Forwarded to each shard fetch (auth, cookies, bookmark). */
    headers?: Record<string, string>;
}

/** The bits of a request the per-shard RPC actually needs; `FanOutRequest` is a superset. */
type ShardRpcRequest = Pick<FanOutRequest, "args" | "functionPath" | "headers">;

/**
 * Cross-shard migration request. Unlike {@link FanOutRequest} there is no merge
 * strategy — per-shard payloads are `MigrationRunResult`-shaped objects, not
 * rows, so {@link QueryCoordinator.orchestrateMigration} rolls them up with the
 * fixed semantics documented on {@link MigrationFanOutResult}.
 *
 * `functionPath` is the admin RPC to invoke on each shard
 * (`__lunora_admin__:runMigration` or `:migrationStatus`); `headers` must carry
 * the `Authorization` bearer header the shard's admin gate requires (the
 * configured admin token), or every shard comes back as a 403 error.
 */
interface MigrationFanOutRequest {
    args?: Record<string, unknown>;

    /** {@link DefaultShardKey} — the shard fallback, or `null` for none. */
    defaultShardKey: DefaultShardKey;
    functionPath: string;
    headers?: Record<string, string>;
    /** Table whose live shard keys the migration runs across. */
    table: string;
}

/** One shard's outcome: either the unwrapped admin `result` payload, or an error. */
interface ShardMigrationOutcome {
    error?: { message: string; timedOut: boolean };
    /** The shard's admin `result`, peeled out of the `{ result }` envelope. */
    result?: unknown;
    shardKey: string;
}

interface MigrationFanOutResult {
    /** Summed `changed` across shards whose result carried a numeric count. */
    changed: number;
    /** Shards that errored or timed out. */
    failed: number;
    /** Shards that returned a 2xx result. */
    ok: number;
    /** Summed `processed` across shards whose result carried a numeric count. */
    processed: number;
    /** Per-shard outcomes, in registry order. */
    shards: ReadonlyArray<ShardMigrationOutcome>;

    /**
     * Rolled-up status. `"failed"` if any shard's runner reported failure;
     * `"in_progress"` if any shard is incomplete or unreachable (the run stays
     * resumable); `"completed"` only when every shard finished cleanly.
     */
    status: "completed" | "failed" | "in_progress";
}

/**
 * Cross-shard rank request. Like {@link MigrationFanOutRequest} there is no
 * caller-supplied merge — per-shard payloads are `{before, total}` objects, so
 * {@link QueryCoordinator.orchestrateRank} rolls them up with the fixed
 * `{position: Σbefore + 1, total: Σtotal}` semantics {@link mergeRank} defines.
 *
 * The key tuple (`partitionKey`/`sortValues`/`rowId`) is built off the row doc
 * via `@lunora/do`'s `rankKeyFromDoc(index, doc)` and forwarded verbatim to
 * each shard's `__lunora_admin__:rankBefore` admin RPC; `headers` must carry
 * the admin bearer the shard's admin gate requires.
 */
interface RankFanOutRequest {
    headers?: Record<string, string>;
    /** Rank index name on `table`. */
    index: string;
    /** Canonical-JSON partition tuple — `encodePartitionKey(index.partitionBy, doc)`. */
    partitionKey: string;
    /** The `__id__` tiebreak value — `doc._id`. */
    rowId: string;
    /** Serialized sort-key values in `index.sortBy` order, as produced by `rankKeyFromDoc` (wire-safe + byte-matching the stored columns). */
    sortValues: ReadonlyArray<unknown>;
    /** Table whose live shard keys the rank fans out across. */
    table: string;
}

interface RankFanOutResult {
    /** Shards that errored or timed out. */
    failed: number;
    /** Shards that returned a 2xx `{before, total}`. */
    ok: number;
    /** `true` when at least one shard failed/timed out, so `position`/`total` are under-counts (failed shards' rows missing). A caller needing an exact global rank should treat this as an error, not trust the numbers. */
    partial: boolean;
    /** 1-based global position within the partition (`Σbefore + 1`). */
    position: number;
    /** Per-shard outcomes, in registry order. */
    shards: ReadonlyArray<ShardRankOutcome>;
    /** Global partition total (`Σtotal`). */
    total: number;
}

/** One shard's rank outcome: its `{before, total}` payload, or an error. */
interface ShardRankOutcome {
    error?: { message: string; timedOut: boolean };
    result?: { before: number; total: number };
    shardKey: string;
}

/*
 * The shard-local rank-page wire types — `RankPageKey` (per-row sort key, byte-
 * identical to the companion's `ORDER BY __partition__, __sort_k<i>__, __id__`),
 * `RankPageRow`, `RankPageDirection`, and `ShardRankPageResult` — are owned by
 * `@lunora/do` (which writes the rank companion the keys mirror) and imported at
 * the top of this file, so this cross-package wire contract has a single source
 * of truth instead of two structurally-identical copies that can silently drift.
 * They are re-exported below under the same `@lunora/runtime` public names.
 */

/**
 * Cross-shard ranked-pagination request. Like {@link RankFanOutRequest} there's
 * no caller-supplied merge — the merge is the fixed k-way merge by the rank-key
 * tuple. `take` is the global page size; `cursor` is the opaque composite cursor
 * from the prior page's `continueCursor` (absent → first page). `partitionKey`,
 * when set, pins a single partition (`encodePartitionKey(index.partitionBy, where)`),
 * forwarded so each shard scopes its local slice to that partition.
 *
 * `directions` is the per-sort-key direction list (`index.sortBy[i].direction`)
 * the coordinator's comparator needs to break ties the same way each shard's
 * `ORDER BY` does. `partitionKey` and the `__id__` tiebreak are always ascending
 * (matching the shard companion's btree), so only the sort columns vary.
 */
interface RankPageFanOutRequest {
    /** Opaque composite cursor from the prior page's `continueCursor`. */
    cursor?: null | string;
    /** Per-sort-key directions, in `index.sortBy` order. Missing/short → ascending. */
    directions?: ReadonlyArray<RankPageDirection>;
    headers?: Record<string, string>;
    /** Rank index name on `table`. */
    index: string;
    /** Optional partition pin forwarded to each shard's local `rankPage`. */
    partitionKey?: string;
    /** Table whose live shard keys the page fans out across. */
    table: string;
    /** Global page size; defaults to 100, capped at 1000 (matching the shard-local `rankPage`). */
    take?: number;
}

/** One shard's `rankPage` outcome: its local ranked slice, or an error. */
interface ShardRankPageOutcome {
    /** The directions the shard ordered by (`index.sortBy[i].direction`); authoritative for the merge. */
    directions?: ReadonlyArray<RankPageDirection>;
    error?: { message: string; timedOut: boolean };
    hasMore?: boolean;
    rows?: ReadonlyArray<RankPageRow>;
    shardKey: string;
}

interface RankPageFanOutResult {
    /** Opaque composite cursor for the next page, or `null` when the merge is exhausted. */
    continueCursor: null | string;
    /** Shards that errored or timed out. */
    failed: number;
    /** `true` when the global merge has no further rows. */
    isDone: boolean;
    /** Shards that returned a 2xx slice. */
    ok: number;
    /** The globally-ranked page of hydrated docs, in cross-shard rank order. */
    page: ReadonlyArray<Record<string, unknown>>;
    /** `true` when at least one shard failed/timed out, so the page may be missing that shard's rows. */
    partial: boolean;
    /** Per-shard outcomes, in registry order. */
    shards: ReadonlyArray<ShardRankPageOutcome>;
}

interface QueryCoordinator {
    fanOut: <T = unknown>(namespace: ShardNamespaceInput, request: FanOutRequest) => Promise<FanOutResult<T>>;

    /**
     * Fan the `__lunora_admin__:applyCdc` admin RPC out by forwarding each
     * pre-bucketed per-shard batch of CDC changes, rolling up the applied/failed
     * counts. The replay half of point-in-time recovery.
     */
    orchestrateApplyCdc: (namespace: ShardNamespaceInput, request: ApplyCdcFanOutRequest) => Promise<ApplyCdcFanOutResult>;

    /**
     * Fan the `__lunora_admin__:cdcSync` admin RPC out to every live shard,
     * each resumed from its own cursor in `request.cursors` (shardKey → seq).
     * Returns the per-shard change pages plus their new cursors so the caller
     * can checkpoint each shard independently — the streaming-export feed.
     */
    orchestrateCdcSync: (namespace: ShardNamespaceInput, request: CdcSyncFanOutRequest) => Promise<CdcSyncFanOutResult>;

    /**
     * Fan an export admin RPC out to every live shard, returning the
     * per-shard `{rows}` payloads alongside any per-shard errors. Each shard
     * returns a JSON envelope (not a streaming body) so this method is the
     * collector — the worker assembles the NDJSON stream.
     */
    orchestrateExport: (namespace: ShardNamespaceInput, request: ExportFanOutRequest) => Promise<ExportFanOutResult>;

    /**
     * Fan an import admin RPC out by routing each row to its owning shard. The
     * shard registry resolves which shards exist; rows whose table has a
     * `shardBy(field)` are bucketed using that field's value as the shard key,
     * other tables fall back to the runtime's default `__root__` shard.
     */
    orchestrateImport: (namespace: ShardNamespaceInput, request: ImportFanOutRequest) => Promise<ImportFanOutResult>;
    /** Fan a migration admin RPC out to every live shard of a table and roll up the per-shard outcomes. */
    orchestrateMigration: (namespace: ShardNamespaceInput, request: MigrationFanOutRequest) => Promise<MigrationFanOutResult>;

    /**
     * Fan the `__lunora_admin__:rankBefore` admin RPC out to every live shard of
     * a table and roll up the per-shard `{before, total}` payloads into the
     * global rank (`{position: Σbefore + 1, total: Σtotal}`). The cross-shard
     * `rank()` path for a partition that spans shards.
     */
    orchestrateRank: (namespace: ShardNamespaceInput, request: RankFanOutRequest) => Promise<RankFanOutResult>;

    /**
     * Page a ranked query across every live shard of a `.shardBy(...)` table.
     * Fans `__lunora_admin__:rankPage` out to each shard, gathers each shard's
     * local ranked slice (rows tagged with their rank-key tuple), and k-way
     * merges them by that tuple into one globally-ranked page of `take` rows.
     * The opaque `continueCursor` is a composite of per-shard cursors so the
     * next page resumes each shard strictly-after the last row the global page
     * consumed from it — pages never drop or duplicate a row at a shard
     * boundary. The cross-shard `rankPage()` path (PLAN5 §7.1 / PLAN2 #3).
     */
    orchestrateRankPage: (namespace: ShardNamespaceInput, request: RankPageFanOutRequest) => Promise<RankPageFanOutResult>;

    /**
     * Fan the `__lunora_admin__:getMetrics` admin RPC out to every live shard of
     * a table and collect each shard's lifetime `requests` total into a per-shard
     * `{ shardKey, requests }` distribution. The feed the studio's `hot_shard`
     * advisor lint needs: a single shard's snapshot can't reveal cross-shard
     * skew, so this fans the cheap metrics read out and returns the whole shard
     * set's request volumes (a failed shard surfaces as `requests: 0`).
     */
    orchestrateShardTraffic: (namespace: ShardNamespaceInput, request: ShardTrafficFanOutRequest) => Promise<ShardTrafficFanOutResult>;
    readonly registry: ShardRegistry;
}

/**
 * Cross-shard export request. `tables` is the union of every table the caller
 * wants exported (shard-local **or** global); `headers` carries the admin
 * bearer the per-shard gate expects. Shard registries are queried for the
 * complete set of live shards across all listed shard-local tables.
 */
interface ExportFanOutRequest {
    args?: Record<string, unknown>;

    /** {@link DefaultShardKey} — the shard fallback, or `null` for none. */
    defaultShardKey: DefaultShardKey;
    headers?: Record<string, string>;

    /**
     * Tables driving the fan-out. Shards are derived from the union of each
     * table's live shard keys — so an export of `["users","messages"]` reaches
     * every shard that holds either table. Globals are skipped here; the
     * worker reads them from D1 directly.
     */
    tables: ReadonlyArray<string>;
}

/** Per-shard export outcome. */
interface ShardExportOutcome {
    error?: { message: string; timedOut: boolean };
    /** Rows from this shard, or undefined when an error occurred. */
    rows?: ReadonlyArray<{ doc: Record<string, unknown>; table: string }>;
    shardKey: string;
}

interface ExportFanOutResult {
    failed: number;
    ok: number;
    shards: ReadonlyArray<ShardExportOutcome>;
}

/**
 * Cross-shard change-data-capture request. `tables` drives shard discovery (the
 * union of their live shard keys, like export); `cursors` maps each shard key
 * to the `seq` it was last read through (absent → from the beginning). `limit`
 * caps each shard's page.
 */
interface CdcSyncFanOutRequest {
    cursors?: Record<string, number>;

    /** {@link DefaultShardKey} — the shard fallback, or `null` for none. */
    defaultShardKey: DefaultShardKey;
    headers?: Record<string, string>;
    limit?: number;
    tables: ReadonlyArray<string>;
}

/** Per-shard CDC page: the changes plus the new cursor to resume this shard from. */
interface ShardCdcOutcome {
    changes?: ReadonlyArray<Record<string, unknown>>;
    /** New per-shard cursor; on error it echoes the shard's prior cursor so a retry resumes cleanly. */
    cursor: number;
    error?: { message: string; timedOut: boolean };
    shardKey: string;
}

interface CdcSyncFanOutResult {
    failed: number;
    ok: number;
    shards: ReadonlyArray<ShardCdcOutcome>;
}

/**
 * Cross-shard import request. Rows have already been bucketed by the runtime
 * into one batch per shard key — the coordinator's job is to forward each
 * batch and roll up the per-shard insert counts + errors.
 */
interface ImportFanOutRequest {
    /**
     * Per-shard batches keyed by shard key. Each entry will be POSTed as the
     * `rows` arg of `__lunora_admin__:importShard`. The shard's
     * starting-line-number for error attribution is carried in `startLine`.
     */
    batches: ReadonlyArray<{ rows: ReadonlyArray<{ doc: Record<string, unknown>; table: string }>; shardKey: string; startLine?: number }>;
    headers?: Record<string, string>;
}

interface ShardImportOutcome {
    error?: { message: string; timedOut: boolean };
    result?: {
        conflicts: number;
        errors: ReadonlyArray<{ code: string; line: number; message: string; table: string }>;
        inserted: Record<string, number>;
    };
    shardKey: string;
}

interface ImportFanOutResult {
    /** Total conflicts (skipped `_id`s) across shards. */
    conflicts: number;
    /** Errors merged across all per-shard outcomes. */
    errors: ReadonlyArray<{ code: string; line: number; message: string; table: string }>;
    failed: number;
    /** Per-table summed insert counts. */
    inserted: Record<string, number>;
    ok: number;
    shards: ReadonlyArray<ShardImportOutcome>;
}

/**
 * Cross-shard CDC replay request (point-in-time recovery). Changes are
 * pre-bucketed by the runtime into one batch per shard key — the coordinator
 * forwards each batch to `__lunora_admin__:applyCdc` and rolls up the counts.
 */
interface ApplyCdcFanOutRequest {
    batches: ReadonlyArray<{ changes: ReadonlyArray<Record<string, unknown>>; shardKey: string }>;
    headers?: Record<string, string>;
}

interface ApplyCdcFanOutResult {
    /** Total changes applied across shards. */
    applied: number;
    failed: number;
    ok: number;
}

/* -------------------------------------------------------------------------- */
/* Cross-shard traffic feed (hot_shard advisor lint)                          */
/* -------------------------------------------------------------------------- */

/**
 * Cross-shard traffic request. Like {@link MigrationFanOutRequest} there is no
 * caller-supplied merge — each shard's `__lunora_admin__:getMetrics` payload
 * carries its own lifetime `requests` total, and {@link rollUpShardTraffic}
 * collects them into one `{ shardKey, requests }` entry per shard. `headers`
 * must carry the admin bearer the per-shard `getMetrics` gate requires.
 *
 * `table` drives shard discovery: the registry's live shard keys for the table
 * are the shards fanned out to. This is the feed the studio's `hot_shard`
 * runtime advisor consumes to compute cross-shard skew — a single shard's
 * snapshot can't, so the panel fans this out on demand.
 */
interface ShardTrafficFanOutRequest {
    headers?: Record<string, string>;
    /** Table whose live shard keys the traffic fan-out runs across. */
    table: string;
}

/** One shard's traffic total, mirroring the advisor's `AdvisorShardTraffic` (sans the optional `group`). */
interface ShardTrafficEntry {
    /** Lifetime request count read off the shard's `getMetrics` snapshot; `0` for a shard that failed/timed out. */
    requests: number;
    /** The shard key (the DO id name); `""` for the unnamed root shard. */
    shardKey: string;
}

interface ShardTrafficFanOutResult {
    /** Shards that errored or timed out (their `requests` are reported as `0`). */
    failed: number;
    /** Shards that returned a 2xx `getMetrics` snapshot. */
    ok: number;

    /**
     * Per-shard request totals, in registry order. Shaped to plug straight into
     * the advisor's `LintContext.shardTraffic` so the `hot_shard` lint can
     * compute the cross-shard share. A failed shard still appears (with
     * `requests: 0`) so callers see the full shard set.
     */
    shards: ReadonlyArray<ShardTrafficEntry>;
}

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_TIMEOUT_MS = 5000;

/** Admin RPCs wrap their payload in `{ result }`; peel it so callers see the runner's value. */
const unwrapResult = (value: unknown): unknown => (value !== null && typeof value === "object" && "result" in value ? value.result : value);

/** Numeric counts + status read defensively off a `MigrationRunResult`-shaped payload. */
const readRunCounts = (payload: unknown): { changed: number; processed: number; status: string | undefined } => {
    const run = (payload ?? {}) as { changed?: unknown; processed?: unknown; status?: unknown };

    return {
        changed: typeof run.changed === "number" ? run.changed : 0,
        processed: typeof run.processed === "number" ? run.processed : 0,
        status: typeof run.status === "string" ? run.status : undefined,
    };
};

/** `"failed"` dominates, then incompleteness; an all-clean run reports `"completed"`. */
const rollUpStatus = (anyFailed: boolean, incomplete: boolean): MigrationFanOutResult["status"] => {
    if (anyFailed) {
        return "failed";
    }

    if (incomplete) {
        return "in_progress";
    }

    return "completed";
};

/**
 * Fold per-shard RPC outcomes into a {@link MigrationFanOutResult}: sum the
 * numeric counts, collect each shard's payload (or error), and roll the
 * statuses up so a single failed shard reports `"failed"` and an incomplete or
 * unreachable shard reports `"in_progress"`.
 */
const rollUpMigration = (results: ReadonlyArray<ShardRpcOutcome>): MigrationFanOutResult => {
    const shards: ShardMigrationOutcome[] = [];
    let ok = 0;
    let failed = 0;
    let changed = 0;
    let processed = 0;
    let anyInProgress = false;
    let anyFailed = false;

    for (const result of results) {
        if (result.kind === "err") {
            failed += 1;
            shards.push({ error: { message: result.message, timedOut: result.timedOut }, shardKey: result.shardKey });
            continue;
        }

        ok += 1;

        const payload = unwrapResult(result.value);
        const counts = readRunCounts(payload);

        changed += counts.changed;
        processed += counts.processed;
        anyInProgress ||= counts.status === "in_progress";
        anyFailed ||= counts.status === "failed";

        shards.push({ result: payload, shardKey: result.shardKey });
    }

    return { changed, failed, ok, processed, shards, status: rollUpStatus(anyFailed, anyInProgress || failed > 0) };
};

/** Read a `{before, total}` payload defensively off an unwrapped rankBefore result. */
const readRankCounts = (payload: unknown): { before: number; total: number } => {
    const run = (payload ?? {}) as { before?: unknown; total?: unknown };

    return {
        before: typeof run.before === "number" && Number.isFinite(run.before) ? run.before : 0,
        total: typeof run.total === "number" && Number.isFinite(run.total) ? run.total : 0,
    };
};

/**
 * Fold per-shard `rankBefore` outcomes into a {@link RankFanOutResult}: sum the
 * strictly-before counts (+1 for the 1-based position) and the partition totals
 * across shards, collecting each shard's `{before, total}` payload (or error).
 * A failed shard contributes nothing to the sums — the partial result still
 * surfaces, with the failure recorded per shard.
 */
const rollUpRank = (results: ReadonlyArray<ShardRpcOutcome>): RankFanOutResult => {
    const shards: ShardRankOutcome[] = [];
    let ok = 0;
    let failed = 0;
    let before = 0;
    let total = 0;

    for (const result of results) {
        if (result.kind === "err") {
            failed += 1;
            shards.push({ error: { message: result.message, timedOut: result.timedOut }, shardKey: result.shardKey });
            continue;
        }

        ok += 1;

        const counts = readRankCounts(unwrapResult(result.value));

        before += counts.before;
        total += counts.total;

        shards.push({ result: counts, shardKey: result.shardKey });
    }

    return { failed, ok, partial: failed > 0, position: before + 1, shards, total };
};

/**
 * SQLite storage-class ordering for a single serialized rank-key value.
 * `serializeSqlValue` only ever produces `null | number | string`, and SQLite's
 * `ORDER BY` ranks NULL < numbers < text, then by value within a class. The
 * shard's companion btree (`ORDER BY __partition__, __sort_k<i>__, __id__`) uses
 * exactly this order, so to merge shard slices without gaps or dupes at a
 * boundary the coordinator must compare the same way — a naive `a < b` would
 * mis-order `null` vs numbers and number-vs-string mixes.
 */
const RANK_CLASS_NULL = 0;
const RANK_CLASS_NUMBER = 1;
const RANK_CLASS_TEXT = 2;

/** Three-way `<` comparison. Code-unit order for strings (NOT locale-aware — must match SQLite's BINARY collation), and NaN/±Infinity-safe for numbers where subtraction is not. */
const compareAsc = (a: number | string, b: number | string): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

const rankValueClass = (value: unknown): number => {
    if (value === null || value === undefined) {
        return RANK_CLASS_NULL;
    }

    if (typeof value === "number") {
        return RANK_CLASS_NUMBER;
    }

    // serializeSqlValue collapses everything else (bigint/object/bool) to
    // string|number|null, so a non-number, non-null value is text on the wire.
    return RANK_CLASS_TEXT;
};

/** Compare two serialized rank values under SQLite ascending order (NULL < number < text). */
const compareRankValueAsc = (a: unknown, b: unknown): number => {
    const classA = rankValueClass(a);
    const classB = rankValueClass(b);

    if (classA !== classB) {
        return classA < classB ? -1 : 1;
    }

    if (classA === RANK_CLASS_NULL) {
        return 0;
    }

    if (classA === RANK_CLASS_NUMBER) {
        return compareAsc(a as number, b as number);
    }

    // Text: code-unit comparison, matching the shard's BINARY collation default.
    return compareAsc(String(a), String(b));
};

/**
 * Total order over two rank keys, byte-identical to the shard companion's
 * `ORDER BY __partition__ ASC, __sort_k<i>__ <dir>, __id__ ASC`. Partition and
 * the `__id__` tiebreak are always ascending; each sort column honors its
 * declared direction (`directions[i]`, default `asc`).
 */
const compareRankKeys = (a: RankPageKey, b: RankPageKey, directions: ReadonlyArray<RankPageDirection>): number => {
    const partitionCmp = compareRankValueAsc(a.partitionKey, b.partitionKey);

    if (partitionCmp !== 0) {
        return partitionCmp;
    }

    const length = Math.max(a.sortValues.length, b.sortValues.length);

    for (let i = 0; i < length; i += 1) {
        const valueCmp = compareRankValueAsc(a.sortValues[i], b.sortValues[i]);

        if (valueCmp !== 0) {
            return directions[i] === "desc" ? -valueCmp : valueCmp;
        }
    }

    return compareRankValueAsc(a.rowId, b.rowId);
};

/**
 * Composite cross-shard rank-page cursor: the per-shard cursor each shard
 * resumes from on the next page. A shard whose rows were fully drained on this
 * page AND that reported no more locally (`hasMore: false`) is omitted — it has
 * nothing left to contribute. Shards present in `perShard` resume strictly
 * after the recorded key; absent shards (never paged, or fully exhausted)
 * restart from their beginning, which is correct because a never-consumed shard
 * was behind the global frontier and its head will be re-emitted only if it
 * truly belongs after the cursor (the next page re-merges from each shard's
 * resume point).
 */
interface RankPageCursorState {
    /** shardKey → the rank key the next page resumes strictly-after. */
    perShard: Record<string, RankPageKey>;
}

/** Encode the composite cursor as base64-of-JSON — opaque to callers, same envelope style as the shard-local rank cursor. */
const encodeRankPageCursor = (state: RankPageCursorState): string => toBase64(new TextEncoder().encode(JSON.stringify(state)));

const decodeRankPageCursor = (cursor: string): RankPageCursorState => {
    try {
        const parsed = JSON.parse(new TextDecoder().decode(fromBase64(cursor))) as unknown;

        if (parsed !== null && typeof parsed === "object" && "perShard" in parsed) {
            const { perShard } = parsed as { perShard?: unknown };

            if (perShard !== null && typeof perShard === "object") {
                return { perShard: perShard as Record<string, RankPageKey> };
            }
        }
    } catch {
        // Malformed cursor → start fresh; matches the shard-local reader, which
        // silently ignores a cursor whose decoded length doesn't fit.
    }

    return { perShard: {} };
};

/**
 * One shard's successfully-fetched slice, normalized for the merge: its rows in
 * local rank order plus whether the shard had more rows beyond the slice. A
 * head index walks the rows as the k-way merge consumes them.
 */
interface ShardSlice {
    hasMore: boolean;
    head: number;
    rows: ReadonlyArray<RankPageRow>;
    shardKey: string;
}

/**
 * Read a `ShardRankPageResult` defensively off an unwrapped admin payload. The
 * shard echoes the `directions` it actually ordered by (`index.sortBy[i].direction`);
 * the coordinator trusts those over any caller-supplied `directions` so the merge
 * order always matches each shard's local `ORDER BY` (a pre-feature shard omits
 * the field → empty, and the coordinator falls back to the request directions).
 */
const readRankPageResult = (payload: unknown): ShardRankPageResult => {
    const value = (payload ?? {}) as { directions?: unknown; hasMore?: unknown; rows?: unknown };
    const rows = Array.isArray(value.rows) ? (value.rows as ReadonlyArray<RankPageRow>) : [];
    const directions = Array.isArray(value.directions) ? (value.directions as ReadonlyArray<RankPageDirection>) : [];

    return { directions, hasMore: value.hasMore === true, rows };
};

/**
 * Pick the slice whose current head row sorts globally-smallest under
 * {@link compareRankKeys}, or `undefined` when every slice is drained. The
 * single step of the k-way merge.
 */
const pickSmallestHead = (slices: ShardSlice[], directions: ReadonlyArray<RankPageDirection>): { row: RankPageRow; slice: ShardSlice } | undefined => {
    let best: { row: RankPageRow; slice: ShardSlice } | undefined;

    for (const slice of slices) {
        const row = slice.rows[slice.head];

        if (row === undefined) {
            continue;
        }

        if (best === undefined || compareRankKeys(row.key, best.row.key, directions) < 0) {
            best = { row, slice };
        }
    }

    return best;
};

/**
 * Build the next composite cursor from each shard's resume key. `anyRemaining`
 * is true when any ok shard still has unconsumed rows in its slice or reported
 * more locally, OR when a previously-paged shard is missing from this page's
 * slices (it failed/timed out, so it is unresolved — not done).
 *
 * EVERY recorded resume key carries forward — both the ok shards' keys (updated
 * by the merge) and a prior-paged shard's key when that shard *failed* this page
 * (still in `lastConsumedKey`, absent from `slices`). Dropping a failed shard's
 * key would make it restart from row 0 when it recovers on a later page and
 * re-emit rows already delivered on earlier pages → duplicates across the result.
 * @returns the encoded cursor string, or `null` when all shards are drained.
 */
const buildNextRankPageCursor = (slices: ShardSlice[], lastConsumedKey: Record<string, RankPageKey>): null | string => {
    let anyRemaining = false;
    const sliceKeys = new Set<string>();

    for (const slice of slices) {
        sliceKeys.add(slice.shardKey);

        if (slice.head < slice.rows.length || slice.hasMore) {
            anyRemaining = true;
        }
    }

    // Carry forward every resume key (ok shards + failed prior-paged shards).
    const perShard: Record<string, RankPageKey> = { ...lastConsumedKey };

    // A prior-paged shard absent from this page's slices failed/timed out, so the
    // pagination is unresolved even if every ok shard drained — keep paging so it
    // can be retried (its carried-forward key makes the retry resume, not restart).
    for (const shardKey of Object.keys(lastConsumedKey)) {
        if (!sliceKeys.has(shardKey)) {
            anyRemaining = true;
        }
    }

    if (!anyRemaining) {
        // eslint-disable-next-line unicorn/no-null -- RankPageFanOutResult.continueCursor is `null | string`; null is the documented "no further page" cursor on the wire
        return null;
    }

    return encodeRankPageCursor({ perShard });
};

/**
 * K-way merge of per-shard ranked slices into one globally-ranked page of up to
 * `take` rows. Each slice is already locally sorted by {@link compareRankKeys};
 * we repeatedly take the globally-smallest unconsumed head across shards. The
 * returned `nextCursor`, per shard, records the last key the page consumed from
 * that shard so the next page resumes strictly-after it; `isDone` is true only
 * when every shard is fully drained AND none reported more rows locally.
 */
const kWayMergeRankPages = (
    slices: ShardSlice[],
    take: number,
    directions: ReadonlyArray<RankPageDirection>,
    priorPerShard: Record<string, RankPageKey>,
): { isDone: boolean; nextCursor: null | string; page: ReadonlyArray<Record<string, unknown>> } => {
    const page: Record<string, unknown>[] = [];
    // Seed each shard's resume point from the prior cursor (see
    // buildNextRankPageCursor); overwritten below for shards this page consumes.
    const lastConsumedKey: Record<string, RankPageKey> = { ...priorPerShard };

    while (page.length < take) {
        const best = pickSmallestHead(slices, directions);

        if (best === undefined) {
            break;
        }

        page.push(best.row.doc);
        lastConsumedKey[best.slice.shardKey] = best.row.key;
        best.slice.head += 1;
    }

    const nextCursor = buildNextRankPageCursor(slices, lastConsumedKey);

    return { isDone: nextCursor === null, nextCursor, page };
};

/**
 * Roll per-shard export outcomes into a flat list. The DO admin handler
 * returns `{result: {rows: [...]}}` — `unwrapResult` peels the envelope and we
 * project the inner `rows` array; an error surfaces an empty `rows` so the
 * caller can write the failed-shard entries without a special case.
 */
const rollUpExport = (results: ReadonlyArray<ShardRpcOutcome>): ExportFanOutResult => {
    const shards: ShardExportOutcome[] = [];
    let ok = 0;
    let failed = 0;

    for (const result of results) {
        if (result.kind === "err") {
            failed += 1;
            shards.push({ error: { message: result.message, timedOut: result.timedOut }, shardKey: result.shardKey });
            continue;
        }

        ok += 1;

        const payload = unwrapResult(result.value) as { rows?: ReadonlyArray<{ doc: Record<string, unknown>; table: string }> };
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- payload is an untrusted unwrapped RPC value cast to a shape; guard the null/undefined case
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];

        shards.push({ rows, shardKey: result.shardKey });
    }

    return { failed, ok, shards };
};

/** Roll up per-shard `cdcSync` outcomes, preserving each shard's prior cursor on error. */
const rollUpCdcSync = (results: ReadonlyArray<{ outcome: ShardRpcOutcome; sinceSeq: number }>): CdcSyncFanOutResult => {
    const shards: ShardCdcOutcome[] = [];
    let ok = 0;
    let failed = 0;

    for (const { outcome, sinceSeq } of results) {
        if (outcome.kind === "err") {
            failed += 1;
            // Echo the prior cursor so a retry re-reads from the same point.
            shards.push({ cursor: sinceSeq, error: { message: outcome.message, timedOut: outcome.timedOut }, shardKey: outcome.shardKey });
            continue;
        }

        ok += 1;

        // payload is an untrusted unwrapped RPC value cast to a shape; the cast
        // claims non-nullish but a malformed shard could return anything, so
        // guard both fields (the disable silences the cast-driven false alarm).
        const payload = unwrapResult(outcome.value) as undefined | { changes?: ReadonlyArray<Record<string, unknown>>; cursor?: number };
        const changes = Array.isArray(payload?.changes) ? payload.changes : [];
        const cursor = typeof payload?.cursor === "number" ? payload.cursor : sinceSeq;

        shards.push({ changes, cursor, shardKey: outcome.shardKey });
    }

    return { failed, ok, shards };
};

/** Sum the per-shard `applyCdc` outcomes into a single roll-up. */
const rollUpApplyCdc = (results: ReadonlyArray<ShardRpcOutcome>): ApplyCdcFanOutResult => {
    let ok = 0;
    let failed = 0;
    let applied = 0;

    for (const outcome of results) {
        if (outcome.kind === "err") {
            failed += 1;
            continue;
        }

        ok += 1;

        const payload = unwrapResult(outcome.value) as undefined | { applied?: number };

        applied += typeof payload?.applied === "number" ? payload.applied : 0;
    }

    return { applied, failed, ok };
};

/** Read a shard's lifetime `requests` total defensively off an unwrapped `getMetrics` payload. */
const readShardRequests = (payload: unknown): number => {
    const snapshot = (payload ?? {}) as { requests?: unknown };

    return typeof snapshot.requests === "number" && Number.isFinite(snapshot.requests) && snapshot.requests >= 0 ? snapshot.requests : 0;
};

/**
 * Fold per-shard `getMetrics` outcomes into a {@link ShardTrafficFanOutResult}:
 * one `{ shardKey, requests }` entry per shard, in registry order. A failed /
 * timed-out shard still gets an entry (with `requests: 0`) so the caller sees
 * the full shard set; only ok shards contribute a positive count. The result is
 * shaped to feed the advisor's `hot_shard` lint directly.
 */
const rollUpShardTraffic = (results: ReadonlyArray<ShardRpcOutcome>): ShardTrafficFanOutResult => {
    const shards: ShardTrafficEntry[] = [];
    let ok = 0;
    let failed = 0;

    for (const result of results) {
        if (result.kind === "err") {
            failed += 1;
            shards.push({ requests: 0, shardKey: result.shardKey });
            continue;
        }

        ok += 1;
        shards.push({ requests: readShardRequests(unwrapResult(result.value)), shardKey: result.shardKey });
    }

    return { failed, ok, shards };
};

/** Sum the per-shard import counts/errors into a single roll-up. */
const rollUpImport = (results: ReadonlyArray<ShardRpcOutcome>): ImportFanOutResult => {
    const shards: ShardImportOutcome[] = [];
    const inserted: Record<string, number> = {};
    const errors: { code: string; line: number; message: string; table: string }[] = [];
    let conflicts = 0;
    let ok = 0;
    let failed = 0;

    for (const result of results) {
        if (result.kind === "err") {
            failed += 1;
            shards.push({ error: { message: result.message, timedOut: result.timedOut }, shardKey: result.shardKey });
            continue;
        }

        ok += 1;

        const payload = unwrapResult(result.value) as
            | undefined
            | {
                  conflicts?: number;
                  errors?: ReadonlyArray<{ code: string; line: number; message: string; table: string }>;
                  inserted?: Record<string, number>;
              };
        const shardInserted = payload?.inserted ?? {};

        for (const [table, count] of Object.entries(shardInserted)) {
            inserted[table] = (inserted[table] ?? 0) + count;
        }

        const payloadErrors = payload?.errors;

        if (Array.isArray(payloadErrors)) {
            errors.push(...(payloadErrors as ReadonlyArray<{ code: string; line: number; message: string; table: string }>));
        }

        conflicts += payload?.conflicts ?? 0;

        shards.push({
            result: {
                conflicts: payload?.conflicts ?? 0,
                errors: payload?.errors ?? [],
                inserted: shardInserted,
            },
            shardKey: result.shardKey,
        });
    }

    return { conflicts, errors, failed, inserted, ok, shards };
};

interface ShardRpcOk {
    kind: "ok";
    shardKey: string;
    value: unknown;
}

interface ShardRpcError {
    /** See {@link ShardError.code}. */
    code: string;
    kind: "err";
    message: string;
    shardKey: string;
    timedOut: boolean;
}

type ShardRpcOutcome = ShardRpcError | ShardRpcOk;

/**
 * Per-shard RPC inputs that are identical across an entire fan-out — body,
 * headers, URL. The cross-shard-fanout bench surfaced that callOneShard was
 * paying `JSON.stringify(body)` and `{...headers}` once per shard, even
 * though every shard in a fan-out receives the same payload. Precomputing
 * them once in `runBoundedFanOut` and threading them through saves N-1
 * stringifications + spreads at N = 64.
 */
interface PreparedShardRpc {
    readonly body: string;
    readonly headers: Record<string, string>;
}

const prepareShardRpc = (request: ShardRpcRequest): PreparedShardRpc => {
    return {
        body: JSON.stringify({ args: request.args ?? {}, functionPath: request.functionPath }),
        headers: { "content-type": "application/json", ...request.headers },
    };
};

const callOneShard = async (namespace: ShardNamespaceInput, shardKey: string, prepared: PreparedShardRpc, timeoutMs: number): Promise<ShardRpcOutcome> => {
    const stub = resolveShard(namespace, shardKey);

    // AbortController lets the timeout branch tear the in-flight fetch down
    // rather than orphaning it — without this, a slow shard's response keeps
    // its socket open after we've already resolved with a timeout error.
    const controller = new AbortController();

    const forwarded = new Request("https://shard.internal/rpc", {
        body: prepared.body,
        headers: prepared.headers,
        method: "POST",
        signal: controller.signal,
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<ShardRpcError>((resolve) => {
        timeoutId = setTimeout(() => {
            try {
                controller.abort();
            } catch {
                // AbortController.abort() is documented as safe, but guard
                // against runtime stubs that throw — the timeout error still
                // needs to propagate.
            }

            resolve({ code: "SHARD_TIMEOUT", kind: "err", message: `shard "${shardKey}" timed out after ${String(timeoutMs)}ms`, shardKey, timedOut: true });
        }, timeoutMs);
    });

    const fetchPromise = (async (): Promise<ShardRpcOutcome> => {
        try {
            const response = await stub.fetch(forwarded);

            if (!response.ok) {
                return { code: "SHARD_HTTP_ERROR", kind: "err", message: `shard "${shardKey}" returned ${String(response.status)}`, shardKey, timedOut: false };
            }

            const value = await response.json();

            return { kind: "ok", shardKey, value };
        } catch (error: unknown) {
            // Shape it the way every other error leaving this runtime is shaped.
            // `fanOut` reports failures as DATA — the envelope is `Response.json`-ed
            // to the caller — so a raw `error.message` here would echo whatever the
            // shard (or the platform beneath it) put in a throw. `toErrorBody`
            // echoes a catalogued `LunoraError` and redacts everything else.
            const { body } = toErrorBody(error, { fallbackCode: "INTERNAL", redactedMessage: "shard call failed" });

            return { code: body.code, kind: "err", message: `shard "${shardKey}" failed: ${body.message}`, shardKey, timedOut: false };
        }
    })();

    try {
        return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
    }
};

/**
 * Run `jobs` through `run`, with at most `concurrency` of them in flight at
 * once. A shared cursor lets each of the (at most `concurrency`) workers pull
 * the next unclaimed job, so a fast job doesn't sit idle waiting for a slow
 * sibling started in the same "batch" — the bounded-fan-out shape every
 * multi-shard orchestrator in this file needs, whether every job shares the
 * same request (`runBoundedFanOut`) or each carries its own args/cursor
 * (`orchestrateCdcSync`, `orchestrateImport`, `orchestrateApplyCdc`,
 * `orchestrateRankPage`). Results land at the same index as their job,
 * regardless of completion order.
 *
 * `jobs` must not contain `undefined` — every caller here passes shard keys or
 * pre-bucketed batch objects, never a sparse/optional array, and a literal
 * `undefined` element would be indistinguishable from "past the end" and end
 * the worker early.
 */
const runBoundedJobs = async <T, R>(jobs: ReadonlyArray<T>, concurrency: number, run: (job: T, index: number) => Promise<R>): Promise<R[]> => {
    if (jobs.length === 0) {
        return [];
    }

    const results: R[] = Array.from({ length: jobs.length });
    let cursor = 0;

    const worker = async (): Promise<void> => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- bounded-concurrency worker loops until the shared cursor is exhausted (guarded below)
        while (true) {
            const index = cursor;

            cursor += 1;

            const job = jobs[index];

            if (index >= jobs.length || job === undefined) {
                return;
            }

            // eslint-disable-next-line no-await-in-loop -- intentional: each worker processes jobs sequentially while `concurrency` workers run in parallel
            results[index] = await run(job, index);
        }
    };

    const workerCount = Math.min(concurrency, jobs.length);

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
};

/** Union of the live shard keys across every requested table, so a multi-table fan-out reaches each shard once. */
const unionShardKeys = async (registry: ShardRegistry, tables: ReadonlyArray<string>): Promise<string[]> => {
    const perTableKeys = await Promise.all(tables.map(async (table) => registry.listShardKeys(table)));

    return [...new Set(perTableKeys.flat())];
};

/**
 * Resolve the shards a fan-out should reach, falling back to the default shard
 * when discovery finds nothing.
 *
 * Discovery is registry-driven, and a registry only knows the keys an app
 * registers for its `.shardBy(...)` tables. A plain root-DO table has no entry
 * and never will, so an empty result means "the registry cannot answer", NOT
 * "there is nothing to do" — and the two are indistinguishable to the caller.
 * Every fan-out that treats them as the same thing reports success having
 * touched nothing: export streamed an empty file, and a data migration reported
 * `status: "completed"` with `processed: 0`.
 *
 * `orchestrateImport` has always resolved this case to the default shard. This
 * is that answer, made shareable.
 *
 * Callers that legitimately mean "no shards, no answer" pass `null` and keep the
 * empty list — see `orchestrateRank`.
 */
const withDefaultShard = (discovered: ReadonlyArray<string>, defaultShardKey: DefaultShardKey): ReadonlyArray<string> =>
    discovered.length > 0 || defaultShardKey === null ? discovered : [defaultShardKey];

const runBoundedFanOut = async (
    namespace: ShardNamespaceInput,
    keys: ReadonlyArray<string>,
    request: ShardRpcRequest,
    maxConcurrency: number,
    timeoutMs: number,
): Promise<ReadonlyArray<ShardRpcOutcome>> => {
    const prepared = prepareShardRpc(request);

    return runBoundedJobs(keys, maxConcurrency, async (shardKey) => callOneShard(namespace, shardKey, prepared, timeoutMs));
};

/**
 * Canonical-JSON encoding of a key tuple — same shape the aggregate counter
 * uses to stay stable across runs. Lets two shards file the same `{ a, b }`
 * group under the same merged bucket regardless of property order.
 */
const canonicalJson = (record: Record<string, unknown>): string => {
    const ordered: Record<string, unknown> = {};

    // Code-unit order (NOT locale-aware) is load-bearing: it must match the
    // aggregate counter's canonical key order across shards, so a localeCompare
    // comparator would risk bucketing the same key tuple differently per shard.
    for (const key of Object.keys(record).toSorted(compareAsc)) {
        // eslint-disable-next-line unicorn/no-null -- the JSON canonical key encoding must serialize missing fields as `null` to stay byte-stable with the aggregate counter across shards
        ordered[key] = record[key] ?? null;
    }

    return JSON.stringify(ordered);
};

const mergeConcat = (values: ReadonlyArray<unknown>): unknown[] => values.flatMap((v) => (Array.isArray(v) ? (v as ReadonlyArray<unknown>) : []));

type GroupByMergeOp = "max" | "min" | "sum";

type GroupByMergedValue = null | number;

const combineGroupByValue = (current: number, incoming: number, op: GroupByMergeOp): number => {
    switch (op) {
        case "max": {
            return Math.max(current, incoming);
        }

        case "min": {
            return Math.min(current, incoming);
        }

        case "sum": {
            return current + incoming;
        }

        default: {
            // Compile-time exhaustiveness guard; an op outside the union can
            // only arrive via untyped input, which the fan-out envelope
            // validation rejects upstream — never evaluate `Math[op]` on it.
            op satisfies never;

            return current;
        }
    }
};

const accumulateGroupByEntry = (merged: Map<string, { key: Record<string, unknown>; value: GroupByMergedValue }>, entry: unknown, op: GroupByMergeOp): void => {
    if (entry === null || typeof entry !== "object") {
        return;
    }

    const entryKey = (entry as { key?: Record<string, unknown> }).key ?? {};
    // eslint-disable-next-line unicorn/no-null -- the per-shard `value` is `null` for a missing aggregate; this `null` is serialized into the merged wire response
    const entryValue = (entry as { value?: GroupByMergedValue }).value ?? null;
    const stableKey = canonicalJson(entryKey);
    const existing = merged.get(stableKey);

    if (!existing) {
        merged.set(stableKey, { key: entryKey, value: entryValue });

        return;
    }

    if (existing.value === null) {
        existing.value = entryValue;

        return;
    }

    if (entryValue === null) {
        return;
    }

    existing.value = combineGroupByValue(existing.value, entryValue, op);
};

const mergeGroupBy = (values: ReadonlyArray<unknown>, op: GroupByMergeOp): ReadonlyArray<{ key: Record<string, unknown>; value: GroupByMergedValue }> => {
    // Reduce per-shard `GroupByEntry[]` payloads into one entry per
    // distinct key tuple. Empty / non-array payloads are skipped — a
    // failed shard already reported through `errors[]`.
    const merged = new Map<string, { key: Record<string, unknown>; value: GroupByMergedValue }>();

    for (const v of values) {
        if (!Array.isArray(v)) {
            continue;
        }

        for (const entry of v) {
            accumulateGroupByEntry(merged, entry, op);
        }
    }

    return [...merged.values()];
};

const mergeNumeric = (values: ReadonlyArray<unknown>, pick: (best: number, candidate: number) => number): GroupByMergedValue => {
    // eslint-disable-next-line unicorn/no-null -- numeric merge returns `null` when no shard reported a finite value; this `null` is the wire response
    let best: GroupByMergedValue = null;

    for (const v of values) {
        if (typeof v === "number" && Number.isFinite(v)) {
            best = best === null ? v : pick(best, v);
        }
    }

    return best;
};

const mergeSum = (values: ReadonlyArray<unknown>): number => {
    let total = 0;

    for (const v of values) {
        if (typeof v === "number" && Number.isFinite(v)) {
            total += v;
        }
    }

    return total;
};

/** Merged cross-shard rank: 1-based global position within the partition, plus the global partition total. */
interface RankMergeResult {
    position: number;
    total: number;
}

/**
 * Fold per-shard `{before, total}` payloads into the global rank. Summing the
 * strictly-before counts across shards and adding 1 gives the 1-based global
 * position; summing the per-shard partition totals gives the global partition
 * size. Non-`{before,total}` / failed payloads contribute nothing (a failed
 * shard already surfaced through `errors[]`).
 *
 * NOTE: this reads `before`/`total` off the RAW per-shard value — the generic
 * `fanOut` contract, where shards return bare query results. The admin
 * `__lunora_admin__:rankBefore` op wraps its payload in `{result}`, so
 * `orchestrateRank`/`rollUpRank` (not this) is the path for that op; it
 * `unwrapResult`s first. Don't point a `{kind:"rank"}` `fanOut` at the admin op.
 */
const mergeRank = (values: ReadonlyArray<unknown>): RankMergeResult => {
    let before = 0;
    let total = 0;

    for (const v of values) {
        if (v === null || typeof v !== "object") {
            continue;
        }

        const payload = v as { before?: unknown; total?: unknown };

        if (typeof payload.before === "number" && Number.isFinite(payload.before)) {
            before += payload.before;
        }

        if (typeof payload.total === "number" && Number.isFinite(payload.total)) {
            total += payload.total;
        }
    }

    return { position: before + 1, total };
};

const mergeTopK = (values: ReadonlyArray<unknown>, strategy: { by: string; direction?: "asc" | "desc"; k: number }): ReadonlyArray<Record<string, unknown>> => {
    const collected: { row: Record<string, unknown>; score: number }[] = [];

    for (const v of values) {
        if (!Array.isArray(v)) {
            continue;
        }

        for (const row of v) {
            if (row === null || typeof row !== "object") {
                continue;
            }

            const raw = (row as Record<string, unknown>)[strategy.by];
            const score = typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY;

            collected.push({ row: row as Record<string, unknown>, score });
        }
    }

    const direction = strategy.direction ?? "desc";

    collected.sort((a, b) => (direction === "asc" ? compareAsc(a.score, b.score) : compareAsc(b.score, a.score)));

    return collected.slice(0, strategy.k).map((entry) => entry.row);
};

const mergeShardResults = (values: ReadonlyArray<unknown>, strategy: MergeStrategy): unknown => {
    switch (strategy.kind) {
        case "concat": {
            return mergeConcat(values);
        }

        case "first": {
            return values[0];
        }

        case "groupBy": {
            return mergeGroupBy(values, strategy.op ?? "sum");
        }

        case "max": {
            return mergeNumeric(values, Math.max);
        }

        case "min": {
            return mergeNumeric(values, Math.min);
        }

        case "rank": {
            return mergeRank(values);
        }

        case "sum": {
            return mergeSum(values);
        }

        case "topK": {
            return mergeTopK(values, strategy);
        }

        default: {
            // Compile-time exhaustiveness guard: `satisfies never` fails the
            // build if a new merge strategy is added without a case. Behaviour
            // is unchanged — an unknown strategy returns the raw values.
            strategy satisfies never;

            return values;
        }
    }
};

const createQueryCoordinator = (options: QueryCoordinatorOptions): QueryCoordinator => {
    const maxConcurrency = options.maxConcurrency ?? DEFAULT_CONCURRENCY;
    const perShardTimeoutMs = options.perShardTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (maxConcurrency < 1) {
        throw new LunoraError("maxConcurrency must be >= 1", { code: "BAD_REQUEST", status: 400 });
    }

    return {
        async fanOut<T>(namespace: ShardNamespaceInput, request: FanOutRequest): Promise<FanOutResult<T>> {
            const keys = await options.registry.listShardKeys(request.fanOut.table);

            const results = await runBoundedFanOut(namespace, keys, request, maxConcurrency, perShardTimeoutMs);

            const okValues: unknown[] = [];
            const errors: ShardError[] = [];

            for (const result of results) {
                if (result.kind === "ok") {
                    okValues.push(result.value);
                } else {
                    errors.push({ code: result.code, message: result.message, shardKey: result.shardKey, timedOut: result.timedOut });
                }
            }

            return {
                data: mergeShardResults(okValues, request.fanOut.merge) as T,
                errors,
                failed: errors.length,
                ok: okValues.length,
            };
        },
        async orchestrateExport(namespace: ShardNamespaceInput, request: ExportFanOutRequest): Promise<ExportFanOutResult> {
            // Union the shard keys across all requested shard-local tables so
            // an export of `["users","messages"]` reaches every shard that
            // holds either table. Skip globals — they live in D1, not a DO.
            const discovered = await unionShardKeys(options.registry, request.tables);

            const shardKeys = withDefaultShard(discovered, request.defaultShardKey);

            const exportRequest: ShardRpcRequest = {
                // Spread the caller's `args` (`batchSize`, future export knobs)
                // before the `tables` field so they reach the shard RPC. The
                // earlier `{ tables }` literal silently dropped them.
                args: { ...request.args, tables: [...request.tables] },
                functionPath: "__lunora_admin__:exportShard",
                headers: request.headers,
            };

            const results = await runBoundedFanOut(namespace, shardKeys, exportRequest, maxConcurrency, perShardTimeoutMs);

            return rollUpExport(results);
        },
        async orchestrateCdcSync(namespace: ShardNamespaceInput, request: CdcSyncFanOutRequest): Promise<CdcSyncFanOutResult> {
            // Discover shards like export — the union of every requested table's
            // live shard keys. Unlike export, each shard resumes from its own
            // cursor, so (like import) we can't reuse `runBoundedFanOut`'s
            // same-args-to-all model; we drive a per-shard-args worker loop.
            const shardKeys = withDefaultShard(await unionShardKeys(options.registry, request.tables), request.defaultShardKey);
            const cursors = request.cursors ?? {};

            const results = await runBoundedJobs(shardKeys, maxConcurrency, async (shardKey) => {
                const sinceSeq = cursors[shardKey] ?? 0;

                const outcome = await callOneShard(
                    namespace,
                    shardKey,
                    prepareShardRpc({
                        args: { limit: request.limit, sinceSeq },
                        functionPath: "__lunora_admin__:cdcSync",
                        headers: request.headers,
                    }),
                    perShardTimeoutMs,
                );

                return { outcome, sinceSeq };
            });

            return rollUpCdcSync(results);
        },
        async orchestrateImport(namespace: ShardNamespaceInput, request: ImportFanOutRequest): Promise<ImportFanOutResult> {
            // Each shard gets its own pre-bucketed batch — we can't reuse
            // `runBoundedFanOut` because that helper sends the same args to
            // every shard. The structure mirrors it: bounded `Promise.all`
            // workers pulling jobs off a shared cursor.
            const { batches } = request;

            const outcomes = await runBoundedJobs(batches, maxConcurrency, async (batch) =>
                callOneShard(
                    namespace,
                    batch.shardKey,
                    prepareShardRpc({
                        args: { rows: [...batch.rows], startLine: batch.startLine ?? 1 },
                        functionPath: "__lunora_admin__:importShard",
                        headers: request.headers,
                    }),
                    perShardTimeoutMs,
                ),
            );

            return rollUpImport(outcomes);
        },
        async orchestrateApplyCdc(namespace: ShardNamespaceInput, request: ApplyCdcFanOutRequest): Promise<ApplyCdcFanOutResult> {
            // Per-shard pre-bucketed batches — same worker-loop shape as
            // orchestrateImport (each shard gets distinct args, so we can't use
            // runBoundedFanOut's same-args-to-all model).
            const { batches } = request;

            const outcomes = await runBoundedJobs(batches, maxConcurrency, async (batch) =>
                callOneShard(
                    namespace,
                    batch.shardKey,
                    prepareShardRpc({
                        args: { changes: [...batch.changes] },
                        functionPath: "__lunora_admin__:applyCdc",
                        headers: request.headers,
                    }),
                    perShardTimeoutMs,
                ),
            );

            return rollUpApplyCdc(outcomes);
        },
        async orchestrateMigration(namespace: ShardNamespaceInput, request: MigrationFanOutRequest): Promise<MigrationFanOutResult> {
            // Without the fallback a migration on a root table fans out to nothing
            // and rolls up as `completed` with `processed: 0` — a backfill the
            // operator is told succeeded and that never ran.
            const keys = withDefaultShard(await options.registry.listShardKeys(request.table), request.defaultShardKey);

            const results = await runBoundedFanOut(namespace, keys, request, maxConcurrency, perShardTimeoutMs);

            return rollUpMigration(results);
        },
        // No `withDefaultShard` on the rank/rankPage/shardTraffic paths below —
        // they are the `defaultShardKey: null` case in permanent form, and that
        // is deliberate: they answer questions ABOUT the shard set, so an empty
        // registry genuinely means "no shards to rank across" rather than "ask the
        // default one". A root-table read never reaches them — codegen routes it
        // straight to the default shard instead of through the coordinator.
        async orchestrateRank(namespace: ShardNamespaceInput, request: RankFanOutRequest): Promise<RankFanOutResult> {
            const keys = await options.registry.listShardKeys(request.table);

            // Every shard receives the same explicit key tuple — the row's
            // partition/sort values + id — and counts its own rows
            // strictly-before it. `rankBefore` works on a peer shard that
            // doesn't store the row, so the partition total stays correct even
            // when the partition spans shards.
            const rankRequest: ShardRpcRequest = {
                args: {
                    index: request.index,
                    partitionKey: request.partitionKey,
                    rowId: request.rowId,
                    sortValues: [...request.sortValues],
                    table: request.table,
                },
                functionPath: "__lunora_admin__:rankBefore",
                headers: request.headers,
            };

            const results = await runBoundedFanOut(namespace, keys, rankRequest, maxConcurrency, perShardTimeoutMs);

            return rollUpRank(results);
        },
        async orchestrateRankPage(namespace: ShardNamespaceInput, request: RankPageFanOutRequest): Promise<RankPageFanOutResult> {
            const keys = await options.registry.listShardKeys(request.table);
            const take = Math.max(1, Math.min(1000, Math.floor(request.take ?? 100)));
            const requestedDirections = request.directions ?? [];
            const cursorState = request.cursor ? decodeRankPageCursor(request.cursor) : { perShard: {} };

            // Each shard resumes from its own cursor, so (like cdcSync) we can't
            // reuse `runBoundedFanOut`'s same-args-to-all model — drive a
            // bounded per-shard-args worker loop. We send the plain global
            // `take`; the shard-local reader internally `LIMIT take + 1`s so its
            // `hasMore` is observable even when the returned slice is exactly
            // `take` long, but the merge only ever emits up to the GLOBAL `take`.
            const outcomes = await runBoundedJobs(keys, maxConcurrency, async (shardKey): Promise<ShardRankPageOutcome> => {
                const shardCursorKey = cursorState.perShard[shardKey];
                const args: Record<string, unknown> = {
                    index: request.index,
                    table: request.table,
                    take,
                };

                if (request.partitionKey !== undefined) {
                    args["partitionKey"] = request.partitionKey;
                }

                if (shardCursorKey !== undefined) {
                    // Forward the prior page's resume key for THIS shard so
                    // it pages strictly-after the last globally-consumed row.
                    args["after"] = shardCursorKey;
                }

                const outcome = await callOneShard(
                    namespace,
                    shardKey,
                    prepareShardRpc({ args, functionPath: "__lunora_admin__:rankPage", headers: request.headers }),
                    perShardTimeoutMs,
                );

                if (outcome.kind === "err") {
                    return { error: { message: outcome.message, timedOut: outcome.timedOut }, shardKey };
                }

                const payload = readRankPageResult(unwrapResult(outcome.value));

                return { directions: payload.directions, hasMore: payload.hasMore, rows: payload.rows, shardKey };
            });

            const slices: ShardSlice[] = [];
            let ok = 0;
            let failed = 0;
            // The shards order their slices by the named index's declared
            // directions and echo them back; trust those over the caller-supplied
            // `directions` so the merge comparator can never disagree with how
            // each shard actually paged (a mismatch would mis-order/drop rows at
            // shard boundaries). Fall back to the request directions only if no
            // shard reported any (e.g. every shard is pre-feature or empty).
            let reportedDirections: ReadonlyArray<RankPageDirection> | undefined;

            for (const outcome of outcomes) {
                if (outcome.error) {
                    failed += 1;

                    continue;
                }

                ok += 1;

                if (reportedDirections === undefined && outcome.directions && outcome.directions.length > 0) {
                    reportedDirections = outcome.directions;
                }

                slices.push({ hasMore: outcome.hasMore ?? false, head: 0, rows: outcome.rows ?? [], shardKey: outcome.shardKey });
            }

            const merged = kWayMergeRankPages(slices, take, reportedDirections ?? requestedDirections, cursorState.perShard);

            return {
                continueCursor: merged.nextCursor,
                failed,
                isDone: merged.isDone,
                ok,
                page: merged.page,
                partial: failed > 0,
                shards: outcomes,
            };
        },
        async orchestrateShardTraffic(namespace: ShardNamespaceInput, request: ShardTrafficFanOutRequest): Promise<ShardTrafficFanOutResult> {
            const keys = await options.registry.listShardKeys(request.table);

            // Every shard receives the same (empty-args) `getMetrics` admin RPC;
            // each returns its own lifetime request total. Reuses the same
            // same-args-to-all `runBoundedFanOut` path as the rank/migration
            // orchestrators — the bearer in `headers` satisfies each shard's
            // admin gate.
            const trafficRequest: ShardRpcRequest = {
                functionPath: "__lunora_admin__:getMetrics",
                headers: request.headers,
            };

            const results = await runBoundedFanOut(namespace, keys, trafficRequest, maxConcurrency, perShardTimeoutMs);

            return rollUpShardTraffic(results);
        },
        registry: options.registry,
    };
};

export { createQueryCoordinator, createStaticShardRegistry };
export type {
    ExportFanOutRequest,
    ExportFanOutResult,
    FanOutRequest,
    FanOutResult,
    FanOutSpec,
    ImportFanOutRequest,
    ImportFanOutResult,
    MergeStrategy,
    MigrationFanOutRequest,
    MigrationFanOutResult,
    QueryCoordinator,
    QueryCoordinatorOptions,
    RankFanOutRequest,
    RankFanOutResult,
    RankPageFanOutRequest,
    RankPageFanOutResult,
    ShardError,
    ShardExportOutcome,
    ShardImportOutcome,
    ShardMigrationOutcome,
    ShardRankOutcome,
    ShardRankPageOutcome,
    ShardRegistry,
    ShardTrafficEntry,
    ShardTrafficFanOutRequest,
    ShardTrafficFanOutResult,
};
// The shard-local rank-page wire types are owned by `@lunora/do` and re-exported
// here for consumers. Kept as a type-only `import` + `export` (not `export…from`)
// on purpose: `@lunora/do` is a type-only dev dependency, so a real re-export
// edge would pull it into the runtime's production dependency graph.
// eslint-disable-next-line unicorn/prefer-export-from -- keep @lunora/do a type-only dev dep; no runtime re-export edge
export type { RankPageDirection, RankPageKey, RankPageRow, ShardRankPageResult };
