/**
 * Cross-shard query coordinator.
 *
 * Lights up when a `.shardBy(...)` table needs an aggregate read — `list`,
 * `search`, `count`, or a "look this up everywhere" call. The coordinator:
 *
 *   1. Asks a {@link ShardRegistry} which shard keys are live for the table.
 *   2. Fans the RPC out to each shard via the same DO namespace the
 *      single-shard path uses (bounded by `maxConcurrency`).
 *   3. Applies a per-shard timeout so one slow shard cannot stall the
 *      aggregate response — slow shards return a {@link ShardError} and the
 *      merge step decides whether that's fatal.
 *   4. Merges results via a {@link MergeStrategy} — `concat`, `sum`,
 *      `topK`, or `first`. All four are serializable from the wire so the
 *      client (or codegen) can describe the merge without sending closures.
 *
 * The DO-storage-backed routing table the plan describes is hidden behind
 * the {@link ShardRegistry} interface — we ship a static implementation
 * (`createStaticShardRegistry`) here and leave the DO/KV-backed registry
 * for a follow-up once codegen opts schemas into cross-shard call sites.
 */
import { CirrusError } from "./errors.js";
import { resolveShard, type ShardNamespaceLike } from "./resolve-shard.js";

/**
 * Source of "which shard keys exist for a given table right now". Returning
 * an empty array is valid — the coordinator will respond with the merge
 * strategy's identity (empty array for `concat`, `0` for `sum`, etc.).
 */
export interface ShardRegistry {
    listShardKeys: (table: string) => Promise<readonly string[]> | readonly string[];
}

/**
 * Static-map implementation. Useful for tests and for small deployments
 * where shard keys are known up front (e.g. a fixed set of channel IDs).
 */
export const createStaticShardRegistry = (table_to_keys: Readonly<Record<string, readonly string[]>>): ShardRegistry => {
    return {
        listShardKeys(table) {
            return table_to_keys[table] ?? [];
        },
    };
};

/**
 * Wire-serializable merge strategy. `topK.by` is a field name on the row
 * (the runtime looks it up with a string key), not a closure.
 */
export type MergeStrategy = { kind: "concat" } | { by: string; direction?: "asc" | "desc"; k: number; kind: "topK" } | { kind: "first" } | { kind: "sum" };

export interface FanOutSpec {
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
export interface ShardError {
    /** Human-readable; tests assert on `.includes("timeout")` and similar. */
    message: string;
    shardKey: string;
    /** Set when the per-shard timeout fired. */
    timedOut: boolean;
}

export interface FanOutResult<T = unknown> {
    /** Merged value — type depends on the merge strategy. */
    data: T;
    errors: readonly ShardError[];
    /** Shards that failed or timed out. */
    failed: number;
    /** Shards that returned successfully. */
    ok: number;
}

export interface QueryCoordinatorOptions {
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

export interface FanOutRequest {
    args?: Record<string, unknown>;
    fanOut: FanOutSpec;
    functionPath: string;
    /** Forwarded to each shard fetch (auth, cookies, bookmark). */
    headers?: Record<string, string>;
}

export interface QueryCoordinator {
    fanOut: <T = unknown>(namespace: ShardNamespaceLike, request: FanOutRequest) => Promise<FanOutResult<T>>;
    readonly registry: ShardRegistry;
}

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_TIMEOUT_MS = 5000;

export const createQueryCoordinator = (options: QueryCoordinatorOptions): QueryCoordinator => {
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
        registry: options.registry,
    };
};

interface ShardRpcOk {
    kind: "ok";
    shardKey: string;
    value: unknown;
}

interface ShardRpcErr {
    kind: "err";
    message: string;
    shardKey: string;
    timedOut: boolean;
}

type ShardRpcOutcome = ShardRpcErr | ShardRpcOk;

const runBoundedFanOut = async (
    namespace: ShardNamespaceLike,
    keys: readonly string[],
    request: FanOutRequest,
    maxConcurrency: number,
    timeoutMs: number,
): Promise<readonly ShardRpcOutcome[]> => {
    if (keys.length === 0) {
        return [];
    }

    const outcomes: ShardRpcOutcome[] = Array.from({ length: keys.length });
    let cursor = 0;

    const worker = async (): Promise<void> => {
        while (true) {
            const index = cursor;

            cursor += 1;

            if (index >= keys.length) {
                return;
            }

            outcomes[index] = await callOneShard(namespace, keys[index]!, request, timeoutMs);
        }
    };

    const concurrency = Math.min(maxConcurrency, keys.length);

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return outcomes;
};

const callOneShard = async (namespace: ShardNamespaceLike, shardKey: string, request: FanOutRequest, timeoutMs: number): Promise<ShardRpcOutcome> => {
    const stub = resolveShard(namespace, shardKey);

    const headers: Record<string, string> = { "content-type": "application/json", ...request.headers };

    const forwarded = new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: request.args ?? {}, functionPath: request.functionPath }),
        headers,
        method: "POST",
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<ShardRpcErr>((resolve) => {
        timeoutId = setTimeout(() => {
            resolve({ kind: "err", message: `shard "${shardKey}" timed out after ${timeoutMs}ms`, shardKey, timedOut: true });
        }, timeoutMs);
    });

    const fetchPromise = (async (): Promise<ShardRpcOutcome> => {
        try {
            const response = await stub.fetch(forwarded);

            if (!response.ok) {
                return { kind: "err", message: `shard "${shardKey}" returned ${response.status}`, shardKey, timedOut: false };
            }

            const value = (await response.json()) as unknown;

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

const mergeShardResults = (values: readonly unknown[], strategy: MergeStrategy): unknown => {
    switch (strategy.kind) {
        case "concat": {
            const out: unknown[] = [];

            for (const v of values) {
                if (Array.isArray(v)) {
                    out.push(...v);
                }
            }

            return out;
        }

        case "first": {
            return values[0];
        }

        case "sum": {
            let total = 0;

            for (const v of values) {
                if (typeof v === "number" && Number.isFinite(v)) {
                    total += v;
                }
            }

            return total;
        }

        case "topK": {
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

            collected.sort((a, b) => direction === "asc" ? a.score - b.score : b.score - a.score);

            return collected.slice(0, strategy.k).map((entry) => entry.row);
        }

        default: {
            const _exhaustive: never = strategy;

            void _exhaustive;

            return values;
        }
    }
};
