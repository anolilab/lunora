/**
 * Continuous change-data export tap (plan 170) — the outbound counterpart to the
 * CDC-in path. Where `./export-stream` is a point-in-time snapshot and
 * `./connector-cdc` powers the STATELESS warehouse pull (the consumer owns the
 * cursor), this module drives a SERVER-owned continuous drain: it reads the
 * ordered per-shard change feed off the op-log (via the coordinator's
 * `orchestrateCdcSync`), delivers each shard's changes to a {@link ExportSink},
 * and persists a durable per-shard cursor so the next pass resumes where this one
 * stopped.
 *
 * Delivery guarantees (plan 170 exit criteria). Ordered, per shard: a shard's
 * changes arrive in op-log `seq` order and are delivered as one ordered batch,
 * with shards independent. At-least-once: a shard's cursor is persisted ONLY
 * after its batch is acknowledged by the sink, so a crash between delivery and
 * cursor-write replays the batch (never at-most-once); the durable cursor mirrors
 * the `__lunora_source_cursor` watermark used by CDC-in. Backpressure without
 * stalling the shard: the tap is a READER of the op-log, so a failing sink never
 * blocks shard writes — on a persistent sink failure the tap retries with
 * exponential backoff and, if still failing, leaves that shard's cursor
 * un-advanced so the next pass re-delivers, while other shards (and the shard's
 * own writes) proceed unaffected.
 */
import type { QueryCoordinator } from "./query-coordinator";
import type { ShardNamespaceLike } from "./resolve-shard";

/**
 * One change in the export stream — a clean projection of the raw op-log CDC
 * record that preserves `seq` (for ordering / idempotency downstream) and the
 * post-image `doc`. A delete carries no `doc`; the primary key survives in `id`.
 */
interface ExportChange {
    doc?: Record<string, unknown>;
    id?: string;
    op: "delete" | "insert" | "update" | "upsert";
    seq?: number;
    table: string;
    ts?: number;
}

/** One shard's batch handed to a sink. `cursor` is the new watermark this batch advances the shard to on ack. */
interface ExportBatch {
    changes: ReadonlyArray<ExportChange>;
    cursor: number;
    shardKey: string;
    sink: string;
}

/**
 * An export sink. `deliver` MUST reject (throw) when the batch was not durably
 * accepted downstream — a resolved promise is treated as an acknowledgement and
 * advances the cursor. Build one with {@link defineExportSink}, or use the
 * built-in {@link webhookExportSink} / {@link r2Sink}.
 */
interface ExportSink {
    deliver: (batch: ExportBatch) => Promise<void>;
    name: string;
}

/**
 * Durable per-shard cursor store, keyed by sink name. Mirrors the
 * `__lunora_source_cursor` watermark from CDC-in: the last op-log `seq` each
 * shard was delivered through. Injected so the tap stays testable and workerd-safe
 * — {@link createMemoryCursorStore} for tests, {@link createKvCursorStore} for a
 * deployment.
 */
interface ExportCursorStore {
    read: (sink: string) => Promise<Record<string, number>>;
    write: (sink: string, cursors: Record<string, number>) => Promise<void>;
}

/** A shard the tap could not drain this pass (sink failure or shard error); its cursor was left un-advanced for retry. */
interface ExportTapFailure {
    error: string;
    shardKey: string;
}

/** Outcome of one drain pass. */
interface ExportTapResult {
    /** The persisted per-shard cursor map after this pass. */
    cursors: Record<string, number>;
    /** Total changes acknowledged by the sink this pass. */
    delivered: number;
    /** Shards left un-advanced (retry pending). Their presence does not stall other shards or the shard's writes. */
    failures: ReadonlyArray<ExportTapFailure>;
    /** `true` when any shard returned a full page (more changes likely remain) or any shard failed — the caller should schedule another pass. */
    hasMore: boolean;
    /** Number of shards inspected this pass. */
    shards: number;
}

/** Options for one {@link runExportTap} drain pass. */
interface RunExportTapOptions {
    /** Cross-shard coordinator providing the op-log change feed. */
    coordinator: QueryCoordinator;
    /** Durable cursor store (per-shard watermark). */
    cursorStore: ExportCursorStore;
    /** Headers forwarded to each shard (identity / admin bearer). */
    headers?: Record<string, string>;
    /** Base backoff in ms for the first retry (doubles each attempt, capped at `maxBackoffMs`). Defaults to `100`. */
    initialBackoffMs?: number;
    /** Per-shard page size. */
    limit?: number;
    /** Cap on the exponential backoff delay. Defaults to `5000`. */
    maxBackoffMs?: number;
    /** Retries after the first delivery attempt before a shard is left for the next pass. Defaults to `3`. */
    maxRetries?: number;
    /** The shard DO namespace to fan the feed across. */
    shardDO: ShardNamespaceLike;
    /** The sink to deliver to. */
    sink: ExportSink;
    /** Injected sleep (defaults to a real timer) so tests drive backoff deterministically. */
    sleep?: (ms: number) => Promise<void>;
    /** Tables driving shard discovery (union of their live shard keys). */
    tables: ReadonlyArray<string>;
}

/** Real timer sleep; swapped out in tests via {@link RunExportTapOptions.sleep}. */
const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Project a raw op-log CDC record (`{ id, op, seq, table, ts, doc? }`) into a
 * clean {@link ExportChange}. Mirrors `./connector-cdc`'s `flattenCdcChange` but
 * PRESERVES `seq` / `id` / `ts` so a downstream warehouse can order and dedupe.
 */
const sanitizeChange = (raw: Record<string, unknown>): ExportChange => {
    const table = typeof raw["table"] === "string" ? raw["table"] : "";
    const rawOp = typeof raw["op"] === "string" ? raw["op"] : "";
    const op: ExportChange["op"] = rawOp === "delete" || rawOp === "insert" || rawOp === "update" ? rawOp : "upsert";
    const id = typeof raw["id"] === "string" ? raw["id"] : undefined;
    const documentRow = raw["doc"] && typeof raw["doc"] === "object" ? (raw["doc"] as Record<string, unknown>) : undefined;
    const seq = typeof raw["seq"] === "number" && Number.isFinite(raw["seq"]) ? raw["seq"] : undefined;
    const ts = typeof raw["ts"] === "number" && Number.isFinite(raw["ts"]) ? raw["ts"] : undefined;

    return {
        op,
        table,
        ...(documentRow === undefined ? {} : { doc: documentRow }),
        ...(id === undefined ? {} : { id }),
        ...(seq === undefined ? {} : { seq }),
        ...(ts === undefined ? {} : { ts }),
    };
};

/** Deliver a batch, retrying on failure with exponential backoff. Throws the last error once retries are exhausted. */
const deliverWithRetry = async (
    sink: ExportSink,
    batch: ExportBatch,
    maxRetries: number,
    initialBackoffMs: number,
    maxBackoffMs: number,
    sleep: (ms: number) => Promise<void>,
): Promise<void> => {
    let attempt = 0;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional retry loop; exits via return (ack) or throw (exhausted)
    while (true) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: each retry must complete before the next backoff
            await sink.deliver(batch);

            return;
        } catch (error: unknown) {
            if (attempt >= maxRetries) {
                throw error instanceof Error ? error : new Error(String(error));
            }

            const delay = Math.min(initialBackoffMs * 2 ** attempt, maxBackoffMs);

            // eslint-disable-next-line no-await-in-loop -- backoff pause between sequential retries
            await sleep(delay);
            attempt += 1;
        }
    }
};

/**
 * Run one drain pass of the export tap for a single sink. Reads the durable
 * cursor, pulls the op-log change feed, delivers each shard's ordered batch (with
 * retry/backoff), advances only the cursors of shards the sink acknowledged, and
 * persists the merged cursor map. Idempotent to schedule repeatedly (cron / admin
 * poke); `hasMore` signals whether another pass is warranted immediately.
 */
const runExportTap = async (options: RunExportTapOptions): Promise<ExportTapResult> => {
    const {
        coordinator,
        cursorStore,
        headers,
        initialBackoffMs = 100,
        limit,
        maxBackoffMs = 5000,
        maxRetries = 3,
        shardDO,
        sink,
        sleep = defaultSleep,
        tables,
    } = options;

    const priorCursors = await cursorStore.read(sink.name);
    const feed = await coordinator.orchestrateCdcSync(shardDO, { cursors: priorCursors, headers, limit, tables });

    const nextCursors: Record<string, number> = { ...priorCursors };
    const failures: ExportTapFailure[] = [];
    let delivered = 0;
    let hasMore = false;

    for (const shard of feed.shards) {
        // A shard the feed itself could not read (timeout / error): leave its
        // cursor untouched so the next pass retries. Never blocks other shards.
        if (shard.error) {
            failures.push({ error: shard.error.message, shardKey: shard.shardKey });
            hasMore = true;

            continue;
        }

        const rawChanges = shard.changes ?? [];

        // Empty page → nothing to deliver; still advance to the shard's reported
        // cursor (it may have moved past filtered rows), a safe no-op for the sink.
        if (rawChanges.length === 0) {
            nextCursors[shard.shardKey] = shard.cursor;

            continue;
        }

        const changes = rawChanges.map((change) => sanitizeChange(change));
        const batch: ExportBatch = { changes, cursor: shard.cursor, shardKey: shard.shardKey, sink: sink.name };

        try {
            // eslint-disable-next-line no-await-in-loop -- shards drained sequentially; a per-shard failure must not abort the others (handled below)
            await deliverWithRetry(sink, batch, maxRetries, initialBackoffMs, maxBackoffMs, sleep);

            // Ack: advance the cursor. At-least-once — the cursor moves only after
            // the sink confirms receipt.
            nextCursors[shard.shardKey] = shard.cursor;
            delivered += changes.length;

            if (limit !== undefined && rawChanges.length >= limit) {
                hasMore = true;
            }
        } catch (error: unknown) {
            // Persistent sink failure for THIS shard: leave the cursor un-advanced
            // (backpressure) so the next pass re-delivers. Other shards proceed.
            failures.push({ error: error instanceof Error ? error.message : String(error), shardKey: shard.shardKey });
            hasMore = true;
        }
    }

    // Persist whatever progress we made — partial advancement is safe and is the
    // point of at-least-once + a durable cursor.
    await cursorStore.write(sink.name, nextCursors);

    return { cursors: nextCursors, delivered, failures, hasMore, shards: feed.shards.length };
};

/**
 * Define a custom export sink. A thin identity wrapper that validates the shape
 * and gives call sites a named factory symmetric with `defineExportSink` in the
 * plan. The `deliver` contract: resolve on durable acceptance, reject otherwise.
 */
const defineExportSink = (config: ExportSink): ExportSink => {
    if (typeof config.name !== "string" || config.name.length === 0) {
        throw new Error("defineExportSink: `name` must be a non-empty string");
    }

    if (typeof config.deliver !== "function") {
        throw new TypeError("defineExportSink: `deliver` must be a function");
    }

    return { deliver: config.deliver, name: config.name };
};

/** NDJSON encode a batch's changes (one JSON object per line). Shared by the webhook + R2 sinks. */
const encodeNdjson = (changes: ReadonlyArray<ExportChange>): string => `${changes.map((change) => JSON.stringify(change)).join("\n")}\n`;

/** `fetch`-like signature so the webhook sink is testable without a real network. */
type FetchLike = (input: string, init: { body: string; headers: Record<string, string>; method: string }) => Promise<{ ok: boolean; status: number }>;

/**
 * Built-in webhook sink: POST the shard's changes as an NDJSON body to `url`. A
 * non-2xx response rejects, so the tap retries + applies backpressure. Idempotency
 * headers (`x-lunora-sink`, `x-lunora-shard`, `x-lunora-cursor`) let the receiver
 * dedupe an at-least-once replay.
 */
const webhookExportSink = (config: { fetchImpl?: FetchLike; headers?: Record<string, string>; name: string; url: string }): ExportSink => {
    const fetchImpl: FetchLike = config.fetchImpl ?? ((input, init) => fetch(input, init));

    return defineExportSink({
        deliver: async (batch) => {
            const response = await fetchImpl(config.url, {
                body: encodeNdjson(batch.changes),
                headers: {
                    "content-type": "application/x-ndjson",
                    "x-lunora-cursor": String(batch.cursor),
                    "x-lunora-shard": batch.shardKey,
                    "x-lunora-sink": batch.sink,
                    ...config.headers,
                },
                method: "POST",
            });

            if (!response.ok) {
                throw new Error(`webhook export sink "${config.name}" returned ${String(response.status)}`);
            }
        },
        name: config.name,
    });
};

/** Minimal R2 bucket surface the sink needs (structurally compatible with an `R2Bucket` binding). */
interface R2PutLike {
    put: (key: string, value: string, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
}

/**
 * Built-in R2 sink: write each shard's changes as an NDJSON object under
 * `<prefix>/<shardKey>/<cursor>.ndjson`. The cursor in the key makes each object
 * content-addressed by watermark, so an at-least-once replay overwrites the same
 * key rather than duplicating (idempotent at the object level). A `put` rejection
 * propagates so the tap retries.
 */
const r2Sink = (config: { bucket: R2PutLike; name: string; prefix?: string }): ExportSink => {
    let prefix = config.prefix ?? "cdc";

    // Trim trailing slashes without a (backtracking-prone) regex.
    while (prefix.endsWith("/")) {
        prefix = prefix.slice(0, -1);
    }

    return defineExportSink({
        deliver: async (batch) => {
            const key = `${prefix}/${batch.shardKey}/${String(batch.cursor)}.ndjson`;

            await config.bucket.put(key, encodeNdjson(batch.changes), { httpMetadata: { contentType: "application/x-ndjson" } });
        },
        name: config.name,
    });
};

/** In-memory cursor store for tests. `snapshot` exposes the persisted cursors for assertions. */
const createMemoryCursorStore = (): ExportCursorStore & { snapshot: () => Record<string, Record<string, number>> } => {
    const state: Record<string, Record<string, number>> = {};

    return {
        read: (sink) => Promise.resolve({ ...state[sink] }),
        snapshot: () => structuredClone(state),
        write: (sink, cursors) => {
            state[sink] = { ...cursors };

            return Promise.resolve();
        },
    };
};

/** Minimal KV surface the cursor store needs (structurally compatible with a `KVNamespace` binding). */
interface KvLike {
    get: (key: string, type: "json") => Promise<unknown>;
    put: (key: string, value: string) => Promise<unknown>;
}

/**
 * KV-backed durable cursor store. The watermark key mirrors the CDC-in
 * convention (`__lunora_source_cursor`): `__lunora_source_cursor:export:<sink>`.
 * A missing / malformed value reads as the empty map (drain from the beginning),
 * so a fresh sink or a corrupted key can never crash the pass.
 */
const createKvCursorStore = (kv: KvLike, options?: { keyPrefix?: string }): ExportCursorStore => {
    const keyPrefix = options?.keyPrefix ?? "__lunora_source_cursor:export";
    const keyFor = (sink: string): string => `${keyPrefix}:${sink}`;

    return {
        read: async (sink) => {
            const raw = await kv.get(keyFor(sink), "json");

            if (raw === null || typeof raw !== "object") {
                return {};
            }

            const cursors: Record<string, number> = {};

            for (const [shardKey, value] of Object.entries(raw as Record<string, unknown>)) {
                if (typeof value === "number" && Number.isFinite(value)) {
                    cursors[shardKey] = value;
                }
            }

            return cursors;
        },
        write: async (sink, cursors) => {
            await kv.put(keyFor(sink), JSON.stringify(cursors));
        },
    };
};

export type { ExportBatch, ExportChange, ExportCursorStore, ExportSink, ExportTapFailure, ExportTapResult, RunExportTapOptions };
export { createKvCursorStore, createMemoryCursorStore, defineExportSink, r2Sink, runExportTap, sanitizeChange, webhookExportSink };
