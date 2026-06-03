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
import { CirrusError } from "./errors.js";
import type { ShardNamespaceLike } from "./resolve-shard.js";
import { resolveShard } from "./resolve-shard.js";

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
 * Each shard's `__cirrus_admin__:rankBefore` returns `{before, total}` (its
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

/**
 * Convenience: build the right wire-serializable {@link MergeStrategy} for a
 * given aggregate read. The reader doesn't know which op the caller chose, so
 * a fan-out wrapper passes the user's op + by-keys through this to derive the
 * merge.
 *
 * - `count` → `sum`.
 * - `aggregate({ op })` → `sum`/`max`/`min` (or throws for `avg`).
 * - `groupBy({ by, agg })` → `groupBy({ op })` (defaults to `sum` since
 * `groupBy`'s default reducer is `count`).
 */
const mergeStrategyForAggregate = (
    input:
        | { agg?: { op?: "avg" | "count" | "max" | "min" | "sum" }; kind: "groupBy" }
        | { kind: "count" }
        | { kind: "scalar"; op: "avg" | "count" | "max" | "min" | "sum" },
): MergeStrategy => {
    if (input.kind === "count") {
        return { kind: "sum" };
    }

    if (input.kind === "scalar") {
        if (input.op === "count" || input.op === "sum") {
            return { kind: "sum" };
        }

        if (input.op === "max") {
            return { kind: "max" };
        }

        if (input.op === "min") {
            return { kind: "min" };
        }

        // avg requires (sum, count) — see jsdoc on MergeStrategy.
        throw new CirrusError('aggregate({ op: "avg" }) is not supported across shards in v1 — fan out sum + count separately', {
            code: "BAD_REQUEST",
            status: 400,
        });
    }

    const op = input.agg?.op ?? "count";

    if (op === "count" || op === "sum") {
        return { kind: "groupBy", op: "sum" };
    }

    if (op === "max") {
        return { kind: "groupBy", op: "max" };
    }

    if (op === "min") {
        return { kind: "groupBy", op: "min" };
    }

    throw new CirrusError('groupBy({ agg: { op: "avg" } }) is not supported across shards in v1 — fan out sum + count separately', {
        code: "BAD_REQUEST",
        status: 400,
    });
};

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
    /** Human-readable; tests assert on `.includes("timeout")` and similar. */
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
 * (`__cirrus_admin__:runMigration` or `:migrationStatus`); `headers` must carry
 * the `Authorization` bearer header the shard's admin gate requires (the
 * configured admin token), or every shard comes back as a 403 error.
 */
interface MigrationFanOutRequest {
    args?: Record<string, unknown>;
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
 * via `@cirrus/do`'s `rankKeyFromDoc(index, doc)` and forwarded verbatim to
 * each shard's `__cirrus_admin__:rankBefore` admin RPC; `headers` must carry
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

interface QueryCoordinator {
    fanOut: <T = unknown>(namespace: ShardNamespaceLike, request: FanOutRequest) => Promise<FanOutResult<T>>;

    /**
     * Fan an export admin RPC out to every live shard, returning the
     * per-shard `{rows}` payloads alongside any per-shard errors. Each shard
     * returns a JSON envelope (not a streaming body) so this method is the
     * collector — the worker assembles the NDJSON stream.
     */
    orchestrateExport: (namespace: ShardNamespaceLike, request: ExportFanOutRequest) => Promise<ExportFanOutResult>;

    /**
     * Fan an import admin RPC out by routing each row to its owning shard. The
     * shard registry resolves which shards exist; rows whose table has a
     * `shardBy(field)` are bucketed using that field's value as the shard key,
     * other tables fall back to the runtime's default `__root__` shard.
     */
    orchestrateImport: (namespace: ShardNamespaceLike, request: ImportFanOutRequest) => Promise<ImportFanOutResult>;
    /** Fan a migration admin RPC out to every live shard of a table and roll up the per-shard outcomes. */
    orchestrateMigration: (namespace: ShardNamespaceLike, request: MigrationFanOutRequest) => Promise<MigrationFanOutResult>;

    /**
     * Fan the `__cirrus_admin__:rankBefore` admin RPC out to every live shard of
     * a table and roll up the per-shard `{before, total}` payloads into the
     * global rank (`{position: Σbefore + 1, total: Σtotal}`). The cross-shard
     * `rank()` path for a partition that spans shards.
     */
    orchestrateRank: (namespace: ShardNamespaceLike, request: RankFanOutRequest) => Promise<RankFanOutResult>;
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
 * Cross-shard import request. Rows have already been bucketed by the runtime
 * into one batch per shard key — the coordinator's job is to forward each
 * batch and roll up the per-shard insert counts + errors.
 */
interface ImportFanOutRequest {
    /**
     * Per-shard batches keyed by shard key. Each entry will be POSTed as the
     * `rows` arg of `__cirrus_admin__:importShard`. The shard's
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

const callOneShard = async (namespace: ShardNamespaceLike, shardKey: string, prepared: PreparedShardRpc, timeoutMs: number): Promise<ShardRpcOutcome> => {
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

            resolve({ kind: "err", message: `shard "${shardKey}" timed out after ${String(timeoutMs)}ms`, shardKey, timedOut: true });
        }, timeoutMs);
    });

    const fetchPromise = (async (): Promise<ShardRpcOutcome> => {
        try {
            const response = await stub.fetch(forwarded);

            if (!response.ok) {
                return { kind: "err", message: `shard "${shardKey}" returned ${String(response.status)}`, shardKey, timedOut: false };
            }

            const value = await response.json();

            return { kind: "ok", shardKey, value };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            return { kind: "err", message: `shard "${shardKey}" threw: ${message}`, shardKey, timedOut: false };
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

const runBoundedFanOut = async (
    namespace: ShardNamespaceLike,
    keys: ReadonlyArray<string>,
    request: ShardRpcRequest,
    maxConcurrency: number,
    timeoutMs: number,
): Promise<ReadonlyArray<ShardRpcOutcome>> => {
    if (keys.length === 0) {
        return [];
    }

    const prepared = prepareShardRpc(request);
    const outcomes: ShardRpcOutcome[] = Array.from({ length: keys.length });
    let cursor = 0;

    const worker = async (): Promise<void> => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- bounded-concurrency worker loops until the shared cursor is exhausted (guarded below)
        while (true) {
            const index = cursor;

            cursor += 1;

            const shardKey = keys[index];

            if (index >= keys.length || shardKey === undefined) {
                return;
            }

            // eslint-disable-next-line no-await-in-loop -- intentional: each worker processes shards sequentially while `concurrency` workers run in parallel
            outcomes[index] = await callOneShard(namespace, shardKey, prepared, timeoutMs);
        }
    };

    const concurrency = Math.min(maxConcurrency, keys.length);

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return outcomes;
};

/**
 * Canonical-JSON encoding of a key tuple — same shape the aggregate counter
 * uses to stay stable across runs. Lets two shards file the same `{ a, b }`
 * group under the same merged bucket regardless of property order.
 */
// Code-unit ordering (NOT locale-aware) is load-bearing: it must match the
// aggregate counter's canonical key order across shards, so a localeCompare
// comparator would risk bucketing the same key tuple differently per shard.
const compareCodeUnits = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

const canonicalJson = (record: Record<string, unknown>): string => {
    const ordered: Record<string, unknown> = {};

    for (const key of Object.keys(record).toSorted(compareCodeUnits)) {
        // eslint-disable-next-line unicorn/no-null -- the JSON canonical key encoding must serialize missing fields as `null` to stay byte-stable with the aggregate counter across shards
        ordered[key] = record[key] ?? null;
    }

    return JSON.stringify(ordered);
};

const mergeConcat = (values: ReadonlyArray<unknown>): unknown[] => {
    const out: unknown[] = [];

    for (const v of values) {
        if (Array.isArray(v)) {
            out.push(...(v as ReadonlyArray<unknown>));
        }
    }

    return out;
};

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
            // Compile-time exhaustiveness guard (no runtime effect).
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
 * `__cirrus_admin__:rankBefore` op wraps its payload in `{result}`, so
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

    collected.sort((a, b) => (direction === "asc" ? a.score - b.score : b.score - a.score));

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
            return mergeNumeric(values, (best, candidate) => Math.max(best, candidate));
        }

        case "min": {
            return mergeNumeric(values, (best, candidate) => Math.min(best, candidate));
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
        throw new CirrusError("maxConcurrency must be >= 1", { code: "BAD_REQUEST", status: 400 });
    }

    return {
        async fanOut<T>(namespace: ShardNamespaceLike, request: FanOutRequest): Promise<FanOutResult<T>> {
            const keys = await options.registry.listShardKeys(request.fanOut.table);

            const results = await runBoundedFanOut(namespace, keys, request, maxConcurrency, perShardTimeoutMs);

            const okValues: unknown[] = [];
            const okShards: string[] = [];
            const errors: ShardError[] = [];

            for (const result of results) {
                if (result.kind === "ok") {
                    okValues.push(result.value);
                    okShards.push(result.shardKey);
                } else {
                    errors.push({ message: result.message, shardKey: result.shardKey, timedOut: result.timedOut });
                }
            }

            const merged = mergeShardResults(okValues, request.fanOut.merge);

            return {
                data: merged as T,
                errors,
                failed: errors.length,
                ok: okShards.length,
            };
        },
        async orchestrateExport(namespace: ShardNamespaceLike, request: ExportFanOutRequest): Promise<ExportFanOutResult> {
            // Union the shard keys across all requested shard-local tables so
            // an export of `["users","messages"]` reaches every shard that
            // holds either table. Skip globals — they live in D1, not a DO.
            const union = new Set<string>();
            const perTableKeys = await Promise.all(request.tables.map(async (table) => options.registry.listShardKeys(table)));

            for (const keys of perTableKeys) {
                for (const key of keys) {
                    union.add(key);
                }
            }

            const shardKeys = [...union];

            const exportRequest: ShardRpcRequest = {
                // Spread the caller's `args` (`batchSize`, future export knobs)
                // before the `tables` field so they reach the shard RPC. The
                // earlier `{ tables }` literal silently dropped them.
                args: { ...request.args, tables: [...request.tables] },
                functionPath: "__cirrus_admin__:exportShard",
                headers: request.headers,
            };

            const results = await runBoundedFanOut(namespace, shardKeys, exportRequest, maxConcurrency, perShardTimeoutMs);

            return rollUpExport(results);
        },
        async orchestrateImport(namespace: ShardNamespaceLike, request: ImportFanOutRequest): Promise<ImportFanOutResult> {
            // Each shard gets its own pre-bucketed batch — we can't reuse
            // `runBoundedFanOut` because that helper sends the same args to
            // every shard. The structure mirrors it: bounded `Promise.all`
            // workers pulling jobs off a shared cursor.
            const { batches } = request;
            const outcomes: ShardRpcOutcome[] = Array.from({ length: batches.length });
            let cursor = 0;

            const concurrency = Math.min(maxConcurrency, batches.length);

            const worker = async (): Promise<void> => {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- bounded-concurrency worker loops until the shared cursor is exhausted (guarded below)
                while (true) {
                    const index = cursor;

                    cursor += 1;

                    const batch = batches[index];

                    if (index >= batches.length || batch === undefined) {
                        return;
                    }

                    // eslint-disable-next-line no-await-in-loop -- intentional: each worker processes batches sequentially while `concurrency` workers run in parallel
                    outcomes[index] = await callOneShard(
                        namespace,
                        batch.shardKey,
                        prepareShardRpc({
                            args: { rows: [...batch.rows], startLine: batch.startLine ?? 1 },
                            functionPath: "__cirrus_admin__:importShard",
                            headers: request.headers,
                        }),
                        perShardTimeoutMs,
                    );
                }
            };

            if (concurrency > 0) {
                await Promise.all(Array.from({ length: concurrency }, () => worker()));
            }

            return rollUpImport(outcomes);
        },
        async orchestrateMigration(namespace: ShardNamespaceLike, request: MigrationFanOutRequest): Promise<MigrationFanOutResult> {
            const keys = await options.registry.listShardKeys(request.table);

            const results = await runBoundedFanOut(namespace, keys, request, maxConcurrency, perShardTimeoutMs);

            return rollUpMigration(results);
        },
        async orchestrateRank(namespace: ShardNamespaceLike, request: RankFanOutRequest): Promise<RankFanOutResult> {
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
                functionPath: "__cirrus_admin__:rankBefore",
                headers: request.headers,
            };

            const results = await runBoundedFanOut(namespace, keys, rankRequest, maxConcurrency, perShardTimeoutMs);

            return rollUpRank(results);
        },
        registry: options.registry,
    };
};

export { createQueryCoordinator, createStaticShardRegistry, mergeStrategyForAggregate };
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
    ShardError,
    ShardExportOutcome,
    ShardImportOutcome,
    ShardMigrationOutcome,
    ShardRankOutcome,
    ShardRegistry,
};
