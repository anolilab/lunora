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
 * **No single-flight.** Two callers that miss at the same instant both run `compute`,
 * and the second write wins. Preventing that needs a lock held across an
 * arbitrarily long external call, which is a different feature with a different
 * failure mode (a crashed holder wedges the key). For the case this targets —
 * repeated identical requests spread over time — the duplicate is a cold-start
 * cost, not a steady-state one.
 *
 * **The stored value is JSON.** Whatever `compute` returns is round-tripped through
 * `JSON.stringify`/`JSON.parse`, so a `Date` comes back as a string and a `Map`
 * comes back as `{}`. Cache what you would send over the wire.
 */

import { v } from "@lunora/values";

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
 * Rows each miss inspects for reaping, and the page size `purgeExpired` deletes
 * in. Small on the write path on purpose: the reap rides a request that is
 * already paying for an external call, so it must stay O(1).
 */
const REAP_BATCH = 8;

/** Pages `purgeExpired` will walk before yielding, so a stuck read cannot spin forever. */
const MAX_PURGE_ROUNDS = 64;

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
    delete: (id: never) => Promise<void>;
    insert: (table: string, document: Record<string, unknown>) => Promise<unknown>;
    patch: (id: never, patch: Record<string, unknown>) => Promise<void>;
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
     * again rather than assuming one pass drained the table.
     */
    purgeExpired: RegisteredMutation<{ limit: ReturnType<typeof v.optional> }, { deleted: number }>;
}

/**
 * SHA-256 of `name` and the serialized args, hex.
 *
 * Hashed rather than stored: call sites routinely pass an entire model request,
 * which is tens of kilobytes. As an indexed column that would be wasteful and
 * would run into column-size limits; a digest is fixed-width and indexes cleanly.
 * The NUL separator keeps `("ab", "c")` and `("a", "bc")` from colliding.
 * @param name the logical cache namespace (usually the action's name)
 * @param argumentsJson the arguments, already serialized
 */

/**
 * Serialize the arguments for hashing. `undefined` becomes the empty string
 * rather than going through `JSON.stringify` (which returns `undefined`, not a
 * string), so a no-argument call still has a stable key.
 * @param args the handler's arguments
 */
const serializeArgs = (args: unknown): string => (args === undefined ? "" : JSON.stringify(args));

const cacheKeyFor = async (name: string, argumentsJson: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${name}\u0000${argumentsJson}`));

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

    /** Drop every entry under `name`, whatever its arguments. */
    invalidateAll: (context: ActionCacheContext, name: string) => Promise<number>;

    /**
     * Return the cached result for `name` + `args`, or run `compute` and cache it.
     *
     * `args` is serialized with `JSON.stringify`, so two calls agree only if their
     * arguments serialize identically — key order included. Pass the handler's
     * own `args` object rather than rebuilding one.
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
            // Drives the hit/miss lookup and the invalidate-by-args delete.
            .index("byKey", ["key"])
            // Drives `invalidateAll`.
            .index("byName", ["name"])
            // Drives the opportunistic reap and `purgeExpired`, both oldest-first.
            .index("byExpiresAt", ["expiresAt"]),
    },
}) as unknown as SchemaExtension<{ [ACTION_CACHE_BARE_TABLE]: ReturnType<typeof defineTable> }>;

// No generated server here, so bind the base context via the builder factory —
// same as `definePresence`.
const { mutation } = initLunora.dataModel().create();

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

        await Promise.all(expired.map(async (row) => context.db.delete(row["_id"] as never)));
    };

    const rowFor = async (context: ActionCacheContext, key: string): Promise<Record<string, unknown> | null> =>
        context.db
            .query(ACTION_CACHE_TABLE)
            .withIndex("byKey", (q) => q.eq("key", key))
            .first();

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
            // round-trips: `JSON.stringify(undefined)` is `undefined` (not a
            // string) and could not be stored at all, while `{}` parses back to
            // the same absent `v`.
            return (JSON.parse(existing["value"] as string) as { v: T }).v;
        }

        const value = await compute();
        const serialized = JSON.stringify({ v: value });
        const expiresAt = now + ttlMs;

        // Oversized results are returned, never stored — see `maxValueBytes`.
        if (new TextEncoder().encode(serialized).length <= maxValueBytes) {
            await (existing
                ? context.db.patch(existing["_id"] as never, { expiresAt, value: serialized })
                : context.db.insert(ACTION_CACHE_TABLE, { expiresAt, key, name, value: serialized }));
        } else if (existing) {
            // A stale row for a key whose fresh answer is too big to keep would
            // otherwise stay readable until it expires, serving the old value
            // while the new one is silently uncached.
            await context.db.delete(existing["_id"] as never);
        }

        await reap(context, now);

        return value;
    };

    const invalidate = async (context: ActionCacheContext, name: string, args: unknown): Promise<void> => {
        const key = await cacheKeyFor(name, serializeArgs(args));
        const existing = await rowFor(context, key);

        if (existing) {
            await context.db.delete(existing["_id"] as never);
        }
    };

    const invalidateAll = async (context: ActionCacheContext, name: string): Promise<number> => {
        let deleted = 0;

        // Bounded rounds rather than one unbounded read: a name that accumulated
        // many argument variants should not have to fit in a single page.
        for (let round = 0; round < MAX_PURGE_ROUNDS; round += 1) {
            // eslint-disable-next-line no-await-in-loop -- each round deletes the page the previous one read; the reads are inherently sequential
            const page = await context.db
                .query(ACTION_CACHE_TABLE)
                .withIndex("byName", (q) => q.eq("name", name))
                .take(REAP_BATCH * 8);

            if (page.length === 0) {
                return deleted;
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            await Promise.all(page.map(async (row) => context.db.delete(row["_id"] as never)));
            deleted += page.length;
        }

        return deleted;
    };

    const purgeExpired = mutation.input({ limit: v.optional(v.number()) }).mutation(async ({ args, ctx: context }): Promise<{ deleted: number }> => {
        const now = Date.now();
        const limit = args.limit !== undefined && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : REAP_BATCH * 32;

        const oldest = await context.db.query(ACTION_CACHE_TABLE).withIndex("byExpiresAt").order("asc").take(limit);
        // The index is ordered by expiry, so the fresh rows are all at the
        // tail — filtering rather than breaking keeps this one pass.
        const expired = oldest.filter((row) => (row["expiresAt"] as number) <= now);

        await Promise.all(expired.map(async (row) => context.db.delete(row["_id"] as never)));

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
