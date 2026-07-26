/* eslint-disable max-classes-per-file -- D1Session and D1Client are both public exports (re-exported by src/index.ts) and are intentionally co-located: the client mints sessions, so splitting them across files would break the cohesive Sessions-API surface consumers import together. */
import type { D1Database } from "@cloudflare/workers-types";
import type { D1DatabaseLike, D1PreparedStatementLike, D1SessionLike } from "@lunora/platform";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";

import { evictOldestEntry } from "../../../shared/evict-oldest";

/**
 * D1 client wrapping the workers `env.DB` binding. The recommended path is
 * `client.withSession(bookmark)` so reads are bookmark-pinned for read-your-
 * writes consistency across replicas; callers should echo the bookmark
 * returned by {@link D1Session.getBookmark} via the `x-d1-bookmark` header.
 *
 * The class also exposes drizzle-typed accessors (`drizzle`, `drizzleSession`,
 * `batch`) for callers that want to build queries against generated
 * `sqliteTable` schemas instead of raw SQL strings.
 */

/**
 * Cap on cached prepared statements per `D1Client` / `D1Session`. The cache
 * uses a `Map` (insertion order = LRU order) so an overflow evicts the
 * oldest-prepared SQL string. Without the bound a worker that dynamically
 * builds SQL (e.g. dialect-compiled `WHERE` clauses with varying columns)
 * would leak references over the worker's lifetime.
 */
const STMT_CACHE_CAPACITY = 256;

/**
 * Bounded LRU statement cache lookup shared by {@link D1Session} and
 * {@link D1Client} (they cache over the same `Map`, differing only in the
 * underlying `prepare` target). A hit bumps the entry to MRU (delete + re-insert,
 * so `Map` insertion order tracks recency); a miss prepares via `prepare`,
 * evicting the oldest entry once {@link STMT_CACHE_CAPACITY} is reached. Extracted
 * to one definition so the subtle eviction/ordering logic can't drift between the
 * two callers.
 */
const prepareCached = (
    cache: Map<string, D1PreparedStatementLike>,
    prepare: (sql: string) => D1PreparedStatementLike,
    sql: string,
): D1PreparedStatementLike => {
    const cached = cache.get(sql);

    if (cached) {
        cache.delete(sql);
        cache.set(sql, cached);

        return cached;
    }

    const stmt = prepare(sql);

    evictOldestEntry(cache, STMT_CACHE_CAPACITY);
    cache.set(sql, stmt);

    return stmt;
};

/**
 * D1 Sessions-API constraint for a bookmark-less first read: serve from any
 * replica for the lowest latency. (`"first-primary"` is the strongly-consistent
 * alternative.) Passed in place of an omitted bookmark so the consistency choice
 * is explicit rather than relying on the binding's default.
 */
const D1_FIRST_UNCONSTRAINED = "first-unconstrained";

/** Thin wrapper over a `D1DatabaseSession` exposing bookmark plumbing. */
class D1Session {
    private readonly session: D1SessionLike;

    /** See {@link D1Client.stmtCache}. Scoped per session. */
    private readonly stmtCache = new Map<string, D1PreparedStatementLike>();

    public constructor(session: D1SessionLike) {
        this.session = session;
    }

    public prepare(sql: string): D1PreparedStatementLike {
        return prepareCached(this.stmtCache, (text) => this.session.prepare(text), sql);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T types the result rows for the caller and is forwarded to the prepared statement.
    public async run<T = unknown>(sql: string, ...binds: unknown[]): Promise<{ meta?: Record<string, unknown>; results?: T[]; success: boolean }> {
        return this.prepare(sql)
            .bind(...binds)
            .run<T>();
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T types the result rows for the caller and is forwarded to the prepared statement.
    public async all<T = unknown>(sql: string, ...binds: unknown[]): Promise<{ results: T[]; success: boolean }> {
        return this.prepare(sql)
            .bind(...binds)
            .all<T>();
    }

    public async first<T = unknown>(sql: string, ...binds: unknown[]): Promise<T | null> {
        return this.prepare(sql)
            .bind(...binds)
            .first<T>();
    }

    /**
     * Returns the most recent bookmark known to the session, or `undefined`
     * when D1 has not issued one yet.
     */
    public getBookmark(): string | undefined {
        return this.session.getBookmark() ?? undefined;
    }
}

class D1Client {
    private readonly db: D1DatabaseLike;

    /**
     * SQL string -> prepared statement. Prepared statements are reusable in
     * D1; preparing the same SQL twice forces the worker to round-trip the
     * statement plan. Caching is per-instance so unit-test isolation holds.
     * Bounded to {@link STMT_CACHE_CAPACITY} via LRU eviction.
     */
    private readonly stmtCache = new Map<string, D1PreparedStatementLike>();

    /**
     * Lazily-built drizzle handle over the bare binding. Memoised so a single
     * `D1Client` reuses the same dialect/session machinery across calls.
     */
    private drizzleHandle: DrizzleD1Database<Record<string, unknown>> | undefined;

    public constructor(database: D1DatabaseLike) {
        this.db = database;
    }

    /**
     * Open a Sessions-API scoped session. Pass the bookmark forwarded by
     * the client to opt into read-your-writes consistency.
     *
     * With no bookmark this is the first request of a session — there is no
     * prior write to read, so we open with the explicit `"first-unconstrained"`
     * constraint (Cloudflare's lowest-latency default: the first read may serve
     * from any replica). Read-your-writes for sequenced requests still flows
     * through the forwarded bookmark; a caller needing a strongly-consistent
     * very-first read should pass `"first-primary"` as the bookmark instead.
     */
    public withSession(bookmark?: string): D1Session {
        const session = this.db.withSession(bookmark ?? D1_FIRST_UNCONSTRAINED);

        return new D1Session(session);
    }

    /**
     * Prepare a statement, reusing a cached one when the SQL text matches.
     * `bind()` on a prepared statement returns a new bound statement and
     * leaves the underlying prepared plan reusable, so cache hits are safe
     * even when the previous caller already called `.bind(...).run()`.
     */
    public prepare(sql: string): D1PreparedStatementLike {
        return prepareCached(this.stmtCache, (text) => this.db.prepare(text), sql);
    }

    /**
     * Drizzle handle over the bare `env.DB` binding. Used for typed queries
     * against generated `sqliteTable` schemas; does **not** participate in the
     * D1 Sessions API (no bookmark pinning). For bookmark-scoped reads, use
     * {@link drizzleSession} instead.
     */
    public get drizzle(): DrizzleD1Database<Record<string, unknown>> {
        if (this.drizzleHandle) {
            return this.drizzleHandle;
        }

        // Structural cast: `D1DatabaseLike` projects exactly the methods
        // `drizzle-orm/d1` introspects (`prepare`, `batch`). The runtime
        // binding ships the full `D1Database` shape; tests pass doubles that
        // match the projection.
        this.drizzleHandle = drizzleD1(this.db as unknown as D1Database, { logger: false });

        return this.drizzleHandle;
    }

    /**
     * Drizzle handle scoped to a D1 Sessions-API session. The bookmark, when
     * supplied, opts into read-your-writes consistency for follow-up reads on
     * the same session.
     *
     * A `D1DatabaseSession` exposes the same `prepare` / `batch` surface
     * drizzle calls into, so a single `unknown` cast lets us treat the session
     * as a `D1Database` for driver-construction purposes.
     */
    public drizzleSession(bookmark?: string): DrizzleD1Database<Record<string, unknown>> {
        const session = this.db.withSession(bookmark ?? D1_FIRST_UNCONSTRAINED);

        return drizzleD1(session as unknown as D1Database, { logger: false });
    }

    /**
     * Atomic batch over the drizzle d1 driver. Mirrors `db.batch([...])`
     * exactly; exposed on the client so callers don't need to hold a drizzle
     * handle just to run a typed batch.
     */
    public async batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(items: T): Promise<BatchResponse<T>> {
        return this.drizzle.batch(items);
    }

    /** Direct access to the underlying binding (advanced use only). */
    public get raw(): D1DatabaseLike {
        return this.db;
    }
}

export { D1Client, D1Session };

export { type D1DatabaseLike, type D1PreparedStatementLike, type D1SessionLike } from "@lunora/platform";
