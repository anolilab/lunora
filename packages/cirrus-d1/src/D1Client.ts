/**
 * Minimal structural projection of `D1Database` to keep the adapter
 * compatible with the real workers-types value as well as unit-test doubles.
 */
export interface D1DatabaseLike {
    batch?: (statements: D1PreparedStatementLike[]) => Promise<unknown[]>;
    exec?: (sql: string) => Promise<unknown>;
    prepare: (sql: string) => D1PreparedStatementLike;
    withSession: (bookmark?: string) => D1SessionLike;
}

export interface D1SessionLike {
    getBookmark: () => string | null;
    prepare: (sql: string) => D1PreparedStatementLike;
}

export interface D1PreparedStatementLike {
    all: <T = unknown>() => Promise<{ results: T[]; success: boolean }>;
    bind: (...values: unknown[]) => D1PreparedStatementLike;
    first: <T = unknown>(column?: string) => Promise<T | null>;
    raw: <T = unknown>() => Promise<T[][]>;
    run: <T = unknown>() => Promise<{ meta?: Record<string, unknown>; results?: T[]; success: boolean }>;
}

/**
 * D1 client wrapping the workers `env.DB` binding. The recommended path is
 * `client.withSession(bookmark)` so reads are bookmark-pinned for read-your-
 * writes consistency across replicas; callers should echo the bookmark
 * returned by {@link D1Session.getBookmark} via the `x-d1-bookmark` header.
 */
export class D1Client {
    private readonly db: D1DatabaseLike;

    /**
     * SQL string -> prepared statement. Prepared statements are reusable in
     * D1; preparing the same SQL twice forces the worker to round-trip the
     * statement plan. Caching is per-instance so unit-test isolation holds.
     */
    private readonly stmtCache = new Map<string, D1PreparedStatementLike>();

    constructor(db: D1DatabaseLike) {
        this.db = db;
    }

    /**
     * Open a Sessions-API scoped session. Pass the bookmark forwarded by
     * the client to opt into read-your-writes consistency.
     */
    public withSession(bookmark?: string): D1Session {
        const session = bookmark === undefined ? this.db.withSession() : this.db.withSession(bookmark);

        return new D1Session(session);
    }

    /**
     * Prepare a statement, reusing a cached one when the SQL text matches.
     * `bind()` on a prepared statement returns a new bound statement and
     * leaves the underlying prepared plan reusable, so cache hits are safe
     * even when the previous caller already called `.bind(...).run()`.
     */
    public prepare(sql: string): D1PreparedStatementLike {
        const cached = this.stmtCache.get(sql);

        if (cached) {
            return cached;
        }

        const stmt = this.db.prepare(sql);

        this.stmtCache.set(sql, stmt);

        return stmt;
    }

    /** Direct access to the underlying binding (advanced use only). */
    public get raw(): D1DatabaseLike {
        return this.db;
    }
}

/** Thin wrapper over a `D1DatabaseSession` exposing bookmark plumbing. */
export class D1Session {
    private readonly session: D1SessionLike;

    /** See {@link D1Client.stmtCache}. Scoped per session. */
    private readonly stmtCache = new Map<string, D1PreparedStatementLike>();

    constructor(session: D1SessionLike) {
        this.session = session;
    }

    public prepare(sql: string): D1PreparedStatementLike {
        const cached = this.stmtCache.get(sql);

        if (cached) {
            return cached;
        }

        const stmt = this.session.prepare(sql);

        this.stmtCache.set(sql, stmt);

        return stmt;
    }

    public async run<T = unknown>(sql: string, ...binds: unknown[]): Promise<{ meta?: Record<string, unknown>; results?: T[]; success: boolean }> {
        return this.prepare(sql)
            .bind(...binds)
            .run<T>();
    }

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
