/**
 * Action-result cache — memoise an expensive `action` by its arguments, with a
 * TTL.
 *
 * An action is where the expensive, non-transactional work lives: a model call,
 * a third-party fetch, an embedding. Those are routinely deterministic in their
 * arguments and routinely paid for per call, so the same arguments arriving twice
 * is money and latency spent on an answer already known. Nothing in the framework
 * memoised that, so every app grew its own table and its own key derivation.
 *
 * This ships it on primitives that already exist — the schema-extension /
 * component system for the table, `ctx.db` for the reads and writes — so it is a
 * preset rather than a new subsystem, in the same shape as `definePresence`.
 *
 * # Wiring
 *
 * ```ts
 * // lunora/cache.ts
 * import { defineActionCache } from "@lunora/server";
 *
 * export const cache = defineActionCache({ ttlMs: 60 * 60 * 1000 });
 *
 * // lunora/schema.ts — merges in as `actionCache_entries`
 * export const schema = defineSchema({ ... }).extend(cache.extension);
 *
 * // Re-export so codegen registers it (schedule it from a cron for bulk cleanup):
 * export const { purgeExpired } = cache.functions;
 * ```
 *
 * Then, in the action:
 *
 * ```ts
 * export const embed = action.input({ text: v.string() }).action(async ({ args, ctx }) =>
 *     cache.wrap(ctx, "embed", args, async () => callEmbeddingModel(args.text)));
 * ```
 *
 * # What it does not do
 *
 * **No single-flight.** Two callers that miss at the same instant both run
 * `compute`; the unique index on `key` means the loser's insert conflicts rather
 * than leaving a second row, so one result is stored and the work was done twice.
 * Preventing that needs a lock held across an arbitrarily long external call,
 * which is a different feature with a worse failure mode (a crashed holder wedges
 * the key). For the case this targets — repeated identical requests spread over
 * time — the duplicate is a cold-start cost, not a steady-state one.
 *
 * **The cache is GLOBAL, not per-caller.** The key is a digest of `(name, args)`
 * and nothing else — no identity component, ever. So
 * `cache.wrap(ctx, "summary", { docId }, () => fetchFor(ctx.auth.userId))` serves
 * the first caller's result to every other caller for the whole TTL: the closure
 * reads an identity the key never saw. Anything that varies by caller has to be
 * IN `args` (`{ docId, userId: ctx.auth.userId }`), which is also what makes the
 * dependence visible at the call site. Nothing here can detect the omission — a
 * `compute` closure is opaque — so this paragraph is the whole guard rail.
 *
 * **The stored value goes through the wire codec**, the same encoding an RPC
 * response uses — so `bigint`, `Date`, `Map`, `Set` and bytes round-trip as
 * themselves. A value the wire refuses (a class instance, a cyclic graph) throws.
 * Cache what you would send over the wire, because that is exactly what this is.
 */

import { isLunoraError } from "@lunora/errors";
import type { Id } from "@lunora/values";
import { v } from "@lunora/values";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { stableWireKey } from "../../../shared/wire-key";
import { initLunora } from "./builder/index";
import type { Component, SchemaExtension } from "./plugin";
import { defineComponent, defineSchemaExtension } from "./plugin";
import { defineTable } from "./schema";
import type { RegisteredMutation } from "./types";

/** Default lifetime of a cached entry: one hour. */
const DEFAULT_ACTION_CACHE_TTL_MS: number = 60 * 60 * 1000;

/**
 * Default cap on a serialized entry (bytes). An over-limit result is returned to
 * the caller but not stored — the point of a cache is to be faster, and failing a
 * successful action because its answer was large would trade a cost saving for an
 * outage. 512 KB clears any ordinary API payload while keeping one entry well
 * inside a shard row.
 */
const DEFAULT_MAX_VALUE_BYTES = 512 * 1024;

/**
 * Rows each miss inspects for reaping. Small on the write path on purpose: the
 * reap rides a request that is already paying for an external call, so it must
 * stay O(1).
 */
const REAP_BATCH = 8;

/** Rows `invalidate`/`invalidateAll` read per round. */
const INVALIDATE_PAGE = 64;

/** Rounds `invalidateAll` will walk, so a reader that stops advancing cannot spin forever. */
const MAX_INVALIDATE_ROUNDS = 64;

/** Default rows `purgeExpired` deletes in one call, and the ceiling on a caller-supplied `limit`. */
const PURGE_DEFAULT_LIMIT = 256;
const PURGE_MAX_LIMIT = 4096;

/** The bare extension key and table name. Prefixing makes the merged table `actionCache_entries`. */
const ACTION_CACHE_KEY = "actionCache";
const ACTION_CACHE_BARE_TABLE = "entries";

/**
 * The prefixed table name the extension produces at merge time. The handlers and
 * helpers read/write this name directly so they always agree with the merged
 * schema.
 */
const ACTION_CACHE_TABLE: "actionCache_entries" = `${ACTION_CACHE_KEY}_${ACTION_CACHE_BARE_TABLE}`;

/**
 * The slice of an index-range builder this preset uses. Mirrors `IndexRangeBuilder`
 * field-for-field so the real `ctx.db` query builder is assignable — the generated
 * `ctx.db.query` is typed per table, and a helper holding a runtime string needs
 * the wide overload.
 */
interface ActionCacheIndexRange {
    eq: (field: string, value: unknown) => ActionCacheIndexRange;
    gt: (field: string, value: unknown) => ActionCacheIndexRange;
    gte: (field: string, value: unknown) => ActionCacheIndexRange;
    lt: (field: string, value: unknown) => ActionCacheIndexRange;
    lte: (field: string, value: unknown) => ActionCacheIndexRange;
}

/** The slice of a `ctx.db` table query this preset relies on. */
interface ActionCacheQuery {
    first: () => Promise<Record<string, unknown> | null>;
    order: (direction: "asc" | "desc") => ActionCacheQuery;
    take: (limit: number) => Promise<Record<string, unknown>[]>;
    withIndex: (indexName: string, range?: (q: ActionCacheIndexRange) => ActionCacheIndexRange) => ActionCacheQuery;
}

/**
 * The slice of the ORM writer (`ctx.db` on an action or mutation) the helpers
 * need. The real `DatabaseWriter` is structurally assignable, so pass `ctx.db`
 * directly.
 */
interface ActionCacheDatabase {
    delete: <T extends string>(id: Id<T>) => Promise<void>;
    insert: (table: string, document: Record<string, unknown>) => Promise<unknown>;
    patch: <T extends string>(id: Id<T>, patch: Record<string, unknown>) => Promise<void>;
    query: (table: string) => ActionCacheQuery;
}

/** The slice of a function context the helpers need — just its writer. */
interface ActionCacheContext {
    db: ActionCacheDatabase;
}

/** Options for {@link defineActionCache}. */
interface DefineActionCacheOptions {
    /**
     * Cap on the serialized size (bytes) of one cached value. A larger result is
     * returned but not stored. Defaults to 512 KB; a non-finite value falls back
     * to the default.
     */
    maxValueBytes?: number;

    /**
     * How long (ms) an entry stays fresh. A read past it reports a miss.
     * Defaults to one hour.
     */
    ttlMs?: number;
}

/** The registered functions an action-cache component ships. */
interface ActionCacheFunctions {
    /**
     * Internal mutation that hard-deletes expired entries, oldest first, and
     * reports how many it removed. Every miss already reaps a few rows
     * opportunistically, so an app with steady traffic stays bounded without
     * this; schedule it on a cron to reclaim entries whose names went quiet.
     *
     * Returns `{ deleted }`; compare it against `limit` to decide whether to run
     * again rather than assuming one pass drained the table. A caller-supplied
     * `limit` is clamped — `take()` has no ceiling of its own.
     */
    purgeExpired: RegisteredMutation<{ limit: ReturnType<typeof v.optional> }, { deleted: number }>;
}

/**
 * Serialize the arguments for hashing.
 *
 * `stableWireKey` rather than `JSON.stringify`, for two reasons that are both
 * correctness rather than taste.
 *
 * It **sorts keys**, so `{ a, b }` and `{ b, a }` are one cache entry. Raw
 * `JSON.stringify` makes them two, and the extra miss is invisible — you just pay
 * twice.
 *
 * It encodes through the **wire codec**, so a `bigint` / `Date` / bytes argument
 * gets a distinct tagged token. `JSON.stringify` throws on `bigint` and renders
 * an `ArrayBuffer` as `{}` — and `{}` for every distinct byte payload under one
 * name is a key COLLISION, i.e. one caller served another caller's cached result.
 * `v.bytes()` and `v.bigint()` are first-class argument types, so that is
 * reachable from ordinary code.
 *
 * A value the wire itself refuses (a class instance, a cyclic graph) throws
 * here, before `compute` runs — such a value can never be a stable key, and
 * failing at the boundary beats hashing something that isn't one.
 * @param args the handler's arguments
 */
const serializeArgs = (args: unknown): string => (args === undefined ? "" : stableWireKey(args));

/**
 * SHA-256 of `name` and the serialized args, hex.
 *
 * Hashed rather than stored: call sites routinely pass an entire model request,
 * which is tens of kilobytes. As an indexed column that would be wasteful and
 * would run into column-size limits; a digest is fixed-width and indexes cleanly.
 * The NUL separator keeps `("ab", "c")` and `("a", "bc")` from colliding.
 * @param name the logical cache namespace (usually the action's name)
 * @param argumentsKey the arguments, already serialized by {@link serializeArgs}
 */
// SCOPE: `name` + args, with NO identity component — the cache is global to the
// shard. Per-caller results must carry the caller in `args`; see the module
// docblock's "What it does not do".
const cacheKeyFor = async (name: string, argumentsKey: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${name}\u0000${argumentsKey}`));

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * The component shape {@link defineActionCache} returns: the extension, the
 * registered functions, and the helpers an action calls directly.
 */
type ActionCacheComponent = {
    functions: ActionCacheFunctions;

    /** Drop the entry for exactly this `name` + `args`. Resolves whether or not one existed. */
    invalidate: (context: ActionCacheContext, name: string, args: unknown) => Promise<void>;

    /**
     * Drop every entry under `name`, whatever its arguments.
     *
     * `complete` is `false` when the paging bound was reached with rows still
     * matching — call again. A plain count could not tell "dropped all of them"
     * apart from "dropped the first few thousand".
     */
    invalidateAll: (context: ActionCacheContext, name: string) => Promise<{ complete: boolean; deleted: number }>;

    /**
     * Return the cached result for `name` + `args`, or run `compute` and cache it.
     *
     * `args` is keyed through the wire codec with sorted keys, so two calls agree
     * whenever their arguments are structurally equal — key order does not matter,
     * and `bigint` / `Date` / bytes arguments key distinctly rather than colliding.
     */
    wrap: <T>(context: ActionCacheContext, name: string, args: unknown, compute: () => Promise<T>) => Promise<T>;
} & Component<{ [ACTION_CACHE_BARE_TABLE]: ReturnType<typeof defineTable> }>;

/**
 * The action-cache schema extension: one `entries` table, auto-namespaced to
 * `actionCache_entries` at merge time.
 */
// Explicit type on this exported const (isolatedDeclarations can't infer it from
// the generic call), matching `presenceExtension`.
const actionCacheExtension = defineSchemaExtension(ACTION_CACHE_KEY, {
    tables: {
        [ACTION_CACHE_BARE_TABLE]: defineTable({
            expiresAt: v.number(),
            key: v.string(),
            name: v.string(),
            value: v.string(),
        })
            // Drives the hit/miss lookup and the invalidate-by-args delete. UNIQUE
            // because one key IS one entry: `wrap` inserts on a miss, so two
            // concurrent misses would otherwise leave two rows under one key, and
            // `.first()` would then serve one while `invalidate` deleted the other.
            .index("byKey", ["key"], { unique: true })
            // Drives `invalidateAll`.
            .index("byName", ["name"])
            // Drives the opportunistic reap and `purgeExpired`, both oldest-first.
            .index("byExpiresAt", ["expiresAt"]),
    },
}) as unknown as SchemaExtension<{ [ACTION_CACHE_BARE_TABLE]: ReturnType<typeof defineTable> }>;

// No generated server here, so bind the base context via the builder factory —
// same as `definePresence`. `internalMutation`, NOT `mutation`: `purgeExpired`
// is a bulk delete, and a public one would let any anonymous caller empty the
// cache table over `/rpc` — turning every subsequent request back into a paid
// upstream call.
const { internalMutation } = initLunora.dataModel().create();

/**
 * Build an action-cache {@link Component} — schema extension, `purgeExpired`, and
 * the `wrap` / `invalidate` / `invalidateAll` helpers — wired to one TTL.
 * @param options cache configuration (TTL, value-size cap).
 * @returns a component bundling the extension, the functions, and the helpers.
 */
const defineActionCache = (options: DefineActionCacheOptions = {}): ActionCacheComponent => {
    // `Number.isFinite` first: a `NaN`/`Infinity` option would otherwise flow
    // through unchanged and land in the row as an expiry nothing can compare.
    const ttlMs = options.ttlMs !== undefined && Number.isFinite(options.ttlMs) ? Math.max(1, Math.floor(options.ttlMs)) : DEFAULT_ACTION_CACHE_TTL_MS;
    const maxValueBytes =
        options.maxValueBytes !== undefined && Number.isFinite(options.maxValueBytes)
            ? Math.max(1, Math.floor(options.maxValueBytes))
            : DEFAULT_MAX_VALUE_BYTES;

    /** Delete up to `REAP_BATCH` already-expired rows. Rides a path already paying for an external call. */
    const reap = async (context: ActionCacheContext, now: number): Promise<void> => {
        const oldest = await context.db.query(ACTION_CACHE_TABLE).withIndex("byExpiresAt").order("asc").take(REAP_BATCH);
        const expired = oldest.filter((row) => (row["expiresAt"] as number) <= now);

        await Promise.all(expired.map(async (row) => context.db.delete(row["_id"] as Id<string>)));
    };

    const rowFor = async (context: ActionCacheContext, key: string): Promise<Record<string, unknown> | null> =>
        context.db
            .query(ACTION_CACHE_TABLE)
            .withIndex("byKey", (q) => q.eq("key", key))
            .first();

    /**
     * Codes a concurrent writer can legitimately produce on the store step.
     *
     * `CONFLICT` is the unique index on `key` doing its job: two callers missed at
     * the same instant, both ran `compute`, and the loser's insert lost the race.
     * `NOT_FOUND` is the refresh equivalent — the row this call read was removed
     * (an `invalidate`, a reap) before the patch landed.
     */
    const CONCURRENT_WRITE_CODES = new Set(["CONFLICT", "NOT_FOUND", "NOT_UNIQUE"]);

    /**
     * Store the entry, tolerating a concurrent writer.
     *
     * A cache write must never fail the call it is caching: `compute` has already
     * run and been paid for, and the value in hand is correct whether or not this
     * process is the one that got to store it. So an expected concurrent-write
     * failure is swallowed — the winner's entry is equivalent — and anything else
     * propagates, because a schema or permission error here is a real problem and
     * silently degrading to "uncached forever" is how it would stay hidden.
     */
    const store = async (context: ActionCacheContext, existing: Record<string, unknown> | null, entry: Record<string, unknown>): Promise<void> => {
        try {
            await (existing
                ? context.db.patch(existing["_id"] as Id<string>, { expiresAt: entry["expiresAt"], value: entry["value"] })
                : context.db.insert(ACTION_CACHE_TABLE, entry));
        } catch (error: unknown) {
            if (isLunoraError(error) && CONCURRENT_WRITE_CODES.has(error.code)) {
                return;
            }

            throw error;
        }
    };

    const wrap = async <T>(context: ActionCacheContext, name: string, args: unknown, compute: () => Promise<T>): Promise<T> => {
        const argumentsJson = serializeArgs(args);
        const key = await cacheKeyFor(name, argumentsJson);
        const now = Date.now();
        const existing = await rowFor(context, key);

        // Expiry is lazy: a read past `expiresAt` reports a miss and leaves the
        // row for the reap below to take, rather than turning every stale read
        // into a delete. The row is overwritten by this same call anyway.
        if (existing && (existing["expiresAt"] as number) > now) {
            // `{ v: value }` rather than the bare value, so a cached `undefined`
            // round-trips: a bare `undefined` does not serialize to a string at
            // all and could not be stored, while `{}` decodes back to the same
            // absent `v`.
            return (decodeWire(JSON.parse(existing["value"] as string)) as { v: T }).v;
        }

        const value = await compute();
        // Through the wire codec, for the same reason the key is: `compute` can
        // legitimately return a `bigint`, a `Date`, or bytes, and raw
        // `JSON.stringify` would throw on the first and quietly flatten the rest —
        // after the caller has already paid for the call.
        const serialized = JSON.stringify(encodeWire({ v: value }));
        // Re-read the clock AFTER `compute`: a 30-second model call would
        // otherwise produce an entry that is already 30 seconds into its own TTL.
        const storedAt = Date.now();
        const expiresAt = storedAt + ttlMs;

        // Oversized results are returned, never stored — see `maxValueBytes`.
        if (new TextEncoder().encode(serialized).length <= maxValueBytes) {
            await store(context, existing, { expiresAt, key, name, value: serialized });
        } else if (existing) {
            // A stale row for a key whose fresh answer is too big to keep would
            // otherwise stay readable until it expires, serving the old value
            // while the new one is silently uncached.
            await context.db.delete(existing["_id"] as Id<string>);
        }

        await reap(context, storedAt);

        return value;
    };

    const invalidate = async (context: ActionCacheContext, name: string, args: unknown): Promise<void> => {
        const key = await cacheKeyFor(name, serializeArgs(args));
        const rows = await context.db
            .query(ACTION_CACHE_TABLE)
            .withIndex("byKey", (q) => q.eq("key", key))
            .take(INVALIDATE_PAGE);

        // Every row under the key, not just `.first()`. The unique index makes a
        // duplicate unreachable in a healthy table — but an invalidation is
        // usually triggered by a permission change or a data correction, and
        // leaving a sibling row behind serves the value the caller just purged.
        await Promise.all(rows.map(async (row) => context.db.delete(row["_id"] as Id<string>)));
    };

    /**
     * Delete one page of `name`'s entries, then recur.
     *
     * Recursive rather than a `for` loop with an `await` in it: the rounds are
     * inherently sequential (each deletes what the previous read returned), and
     * expressing that as recursion says so without silencing `no-await-in-loop`.
     * Depth is bounded by `MAX_INVALIDATE_ROUNDS`.
     */
    const deleteNamedPage = async (
        context: ActionCacheContext,
        name: string,
        deleted: number,
        round: number,
    ): Promise<{ complete: boolean; deleted: number }> => {
        if (round >= MAX_INVALIDATE_ROUNDS) {
            // Hit the liveness bound with rows still matching. Reported rather
            // than returned as a plain count, because "dropped every entry" and
            // "dropped the first few thousand" must not look the same to a caller
            // that asked for the former.
            return { complete: false, deleted };
        }

        const page = await context.db
            .query(ACTION_CACHE_TABLE)
            .withIndex("byName", (q) => q.eq("name", name))
            .take(INVALIDATE_PAGE);

        if (page.length === 0) {
            return { complete: true, deleted };
        }

        await Promise.all(page.map(async (row) => context.db.delete(row["_id"] as Id<string>)));

        return deleteNamedPage(context, name, deleted + page.length, round + 1);
    };

    const invalidateAll = async (context: ActionCacheContext, name: string): Promise<{ complete: boolean; deleted: number }> =>
        // Paged rather than one unbounded read: a name that accumulated many
        // argument variants should not have to fit in a single read.
        deleteNamedPage(context, name, 0, 0);

    const purgeExpired = internalMutation.input({ limit: v.optional(v.number()) }).mutation(async ({ args, ctx: context }): Promise<{ deleted: number }> => {
        const now = Date.now();
        // Clamped, not just floored: `take()` has no ceiling of its own, so an
        // unbounded `limit` is an unbounded index scan inside a mutation.
        const limit =
            args.limit !== undefined && Number.isFinite(args.limit) ? Math.min(PURGE_MAX_LIMIT, Math.max(1, Math.floor(args.limit))) : PURGE_DEFAULT_LIMIT;

        const oldest = await context.db.query(ACTION_CACHE_TABLE).withIndex("byExpiresAt").order("asc").take(limit);
        // The index is ordered by expiry, so the fresh rows are all at the
        // tail — filtering rather than breaking keeps this one pass.
        const expired = oldest.filter((row) => (row["expiresAt"] as number) <= now);

        await Promise.all(expired.map(async (row) => context.db.delete(row["_id"] as Id<string>)));

        return { deleted: expired.length };
    });

    const component = defineComponent(ACTION_CACHE_KEY, {
        extension: actionCacheExtension,
        functions: { purgeExpired },
    }) as ActionCacheComponent;

    return { ...component, invalidate, invalidateAll, wrap };
};

export type { ActionCacheComponent, ActionCacheContext, ActionCacheDatabase, ActionCacheFunctions, DefineActionCacheOptions };
export { DEFAULT_ACTION_CACHE_TTL_MS as ACTION_CACHE_DEFAULT_TTL_MS, ACTION_CACHE_TABLE, actionCacheExtension, cacheKeyFor, defineActionCache };
