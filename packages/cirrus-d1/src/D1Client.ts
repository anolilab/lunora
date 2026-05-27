/**
 * Minimal structural projection of `D1Database` to keep the adapter
 * compatible with the real workers-types value as well as unit-test doubles.
 */
export interface D1DatabaseLike {
    withSession: (bookmark?: string) => D1SessionLike;
    prepare: (sql: string) => D1PreparedStatementLike;
    batch?: (statements: D1PreparedStatementLike[]) => Promise<unknown[]>;
    exec?: (sql: string) => Promise<unknown>;
}

export interface D1SessionLike {
    prepare: (sql: string) => D1PreparedStatementLike;
    getBookmark: () => string | null;
}

export interface D1PreparedStatementLike {
    bind: (...values: unknown[]) => D1PreparedStatementLike;
    first: <T = unknown>(column?: string) => Promise<T | null>;
    all: <T = unknown>() => Promise<{ results: T[]; success: boolean }>;
    run: <T = unknown>() => Promise<{ results?: T[]; success: boolean; meta?: Record<string, unknown> }>;
    raw: <T = unknown>() => Promise<T[][]>;
}

/**
 * D1 client wrapping the workers `env.DB` binding. The recommended path is
 * `client.withSession(bookmark)` so reads are bookmark-pinned for read-your-
 * writes consistency across replicas; callers should echo the bookmark
 * returned by {@link D1Session.getBookmark} via the `x-d1-bookmark` header.
 */
export class D1Client {
    private readonly db: D1DatabaseLike;

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

    /** Escape hatch for callers that don't need a session. */
    public prepare(sql: string): D1PreparedStatementLike {
        return this.db.prepare(sql);
    }

    /** Direct access to the underlying binding (advanced use only). */
    public get raw(): D1DatabaseLike {
        return this.db;
    }
}

/** Thin wrapper over a `D1DatabaseSession` exposing bookmark plumbing. */
export class D1Session {
    private readonly session: D1SessionLike;

    constructor(session: D1SessionLike) {
        this.session = session;
    }

    public prepare(sql: string): D1PreparedStatementLike {
        return this.session.prepare(sql);
    }

    public async run<T = unknown>(sql: string, ...binds: unknown[]): Promise<{ results?: T[]; success: boolean; meta?: Record<string, unknown> }> {
        return this.session.prepare(sql).bind(...binds).run<T>();
    }

    public async all<T = unknown>(sql: string, ...binds: unknown[]): Promise<{ results: T[]; success: boolean }> {
        return this.session.prepare(sql).bind(...binds).all<T>();
    }

    public async first<T = unknown>(sql: string, ...binds: unknown[]): Promise<T | null> {
        return this.session.prepare(sql).bind(...binds).first<T>();
    }

    /**
     * Returns the most recent bookmark known to the session, or `undefined`
     * when D1 has not issued one yet.
     */
    public getBookmark(): string | undefined {
        return this.session.getBookmark() ?? undefined;
    }
}
