/**
 * Secure-by-default write-path guard for `ctx.db`.
 *
 * When a schema is marked `defineSchema(...).rls("required")`, the generated
 * user-facing ctx wraps its writer with {@link guardWriter}. The guard denies
 * every read/write against a PROTECTED table (any table not marked `.public()`)
 * so a procedure that forgot `.use(rls(policies))` fails CLOSED — it can never
 * silently see or mutate a protected table through the unwrapped writer.
 *
 * The guard is transparent to the RLS middleware: it hangs the UNWRAPPED writer
 * off {@link RLS_UNWRAP_SYMBOL}, so `@lunora/server`'s `rls()` middleware
 * recovers the raw writer (via the same `Symbol.for` key — no cross-package
 * import) to evaluate policies and issue policy-filtered reads without tripping
 * the guard. Only procedures that NEVER engaged RLS keep talking to the guard.
 *
 * Admin / migration / studio writers (built from `createShardCtxDb` WITHOUT
 * `enforceRls`) are never guarded — they are trusted system paths.
 */

/**
 * Well-known symbol the guard hangs the unwrapped writer off of. `Symbol.for`
 * (the cross-realm global registry) lets `@lunora/server`'s RLS middleware read
 * it WITHOUT importing this module — both sides reference the same registered
 * symbol by key, dodging a `server → do` dependency.
 */
const RLS_UNWRAP_SYMBOL: symbol = Symbol.for("lunora.ctxdb.rls-unwrap");

/**
 * Thrown when a raw (non-RLS) handler touches a protected table under a
 * `.rls("required")` schema. `code` / `status` / `table` are own properties (not
 * just inherited prototype state) so structural callers across packages — which
 * deliberately avoid a hard `@lunora/do` runtime dependency — recognise the
 * shape without an `instanceof` check (mirrors `ConflictError`).
 */
class RlsRequiredError extends Error {
    public readonly code: string = "RLS_REQUIRED";

    public readonly status: number = 403;

    public readonly table: string;

    public constructor(table: string) {
        super(
            `ctx.db access to "${table}" is denied: the schema is marked .rls("required"), so this table is protected. ` +
                `Apply RLS with .use(rls(policies)) in the procedure, or mark the table .public() to opt it out.`,
        );
        this.name = "RlsRequiredError";
        this.table = table;
    }
}

/** Minimal schema projection the guard reads: the RLS mode + per-table opt-out. */
interface GuardableSchema {
    readonly rlsMode?: "required";
    readonly tables: Record<string, { readonly isPublic?: boolean }>;
}

/**
 * Resolve the owning table of a row id (so a generic `ctx.db.get(id)` with no
 * pinned table can still be gated). May be sync (DO `lookupById`) or async (D1
 * `resolveTableName`). `undefined` ⇒ the id resolves to no table this writer can
 * see (absent row, or another backend) — nothing to leak, so the op passes
 * through to the raw call (which yields `null` / routes on).
 */
type TableOfId = (id: string, expectedTable?: string) => Promise<string | undefined> | string | undefined;

/**
 * Structural surface the guard wraps — method syntax (bivariant params) so the
 * concrete `DatabaseWriterLike` of either dialect satisfies it. The guard reads
 * only the table-targeting methods; everything else is copied through verbatim.
 */
interface GuardableWriter {
    aggregate: (tableName: string, options: unknown) => unknown;
    count: (tableName: string, whereOrArgs?: unknown) => unknown;
    delete: (id: string, expectedTable?: string) => unknown;
    findFirst: (tableName: string, args?: unknown) => unknown;
    findFirstOrThrow: (tableName: string, args?: unknown) => unknown;
    findMany: (tableName: string, args?: unknown) => unknown;
    get: (id: string, expectedTable?: string) => unknown;
    groupBy: (tableName: string, options: unknown) => unknown;
    insert: (tableName: string, document: unknown, options?: unknown) => unknown;
    patch: (id: string, patch: unknown, expectedTable?: string) => unknown;
    query: (tableName: string) => unknown;
    rank: (tableName: string, indexName: string, options: unknown) => unknown;
    rankBefore?: (tableName: string, indexName: string, options: unknown) => unknown;
    rankPage: (tableName: string, indexName: string, options?: unknown) => unknown;
    replace: (id: string, document: unknown, expectedTable?: string) => unknown;
}

/**
 * Wrap `raw` in the secure-by-default guard. A no-op (returns `raw` untouched)
 * unless the schema is `.rls("required")` — so non-secure schemas pay nothing
 * and keep identical behavior. The returned writer is the SAME runtime shape as
 * `raw` (every non-gated method copied through) plus {@link RLS_UNWRAP_SYMBOL}
 * pointing back at `raw`.
 */
const guardWriter = <W extends GuardableWriter>(raw: W, schema: GuardableSchema, tableOfId: TableOfId): W => {
    if (schema.rlsMode !== "required") {
        return raw;
    }

    // Call through the loose structural type so passing `unknown`-typed args back
    // into the concrete writer doesn't fight contravariant property signatures.
    const base: GuardableWriter = raw;

    const isProtected = (tableName: string): boolean => {
        const definition = schema.tables[tableName];

        // Unknown tables aren't gated here — the writer raises its own clear
        // "unknown table" error downstream; only KNOWN, non-public tables are
        // protected.
        return definition !== undefined && definition.isPublic !== true;
    };

    const guardTable = (tableName: string): void => {
        if (isProtected(tableName)) {
            throw new RlsRequiredError(tableName);
        }
    };

    const guardById = async (id: string, expectedTable?: string): Promise<void> => {
        if (expectedTable !== undefined) {
            // The by-id facade (`ctx.db.<table>.get(id)`) pinned the owning
            // table — gate it directly, no probe needed.
            guardTable(expectedTable);

            return;
        }

        // Generic `ctx.db.get(id)` / `patch` / … : resolve the owning table so a
        // protected row can't be addressed by a bare id. An unresolved id leaks
        // nothing, so it passes through.
        const tableName = await tableOfId(id);

        if (tableName !== undefined) {
            guardTable(tableName);
        }
    };

    const baseRankBefore = base.rankBefore;

    const guarded: Record<PropertyKey, unknown> = {
        ...(raw as Record<string, unknown>),
        [RLS_UNWRAP_SYMBOL]: raw,

        aggregate: (tableName: string, options: unknown) => {
            guardTable(tableName);

            return base.aggregate(tableName, options);
        },
        count: (tableName: string, whereOrArgs?: unknown) => {
            guardTable(tableName);

            return base.count(tableName, whereOrArgs);
        },
        delete: async (id: string, expectedTable?: string) => {
            await guardById(id, expectedTable);

            return base.delete(id, expectedTable);
        },
        findFirst: (tableName: string, args?: unknown) => {
            guardTable(tableName);

            return base.findFirst(tableName, args);
        },
        findFirstOrThrow: (tableName: string, args?: unknown) => {
            guardTable(tableName);

            return base.findFirstOrThrow(tableName, args);
        },
        findMany: (tableName: string, args?: unknown) => {
            guardTable(tableName);

            return base.findMany(tableName, args);
        },
        get: async (id: string, expectedTable?: string) => {
            await guardById(id, expectedTable);

            return base.get(id, expectedTable);
        },
        groupBy: (tableName: string, options: unknown) => {
            guardTable(tableName);

            return base.groupBy(tableName, options);
        },
        insert: (tableName: string, document: unknown, options?: unknown) => {
            guardTable(tableName);

            return base.insert(tableName, document, options);
        },
        patch: async (id: string, patch: unknown, expectedTable?: string) => {
            await guardById(id, expectedTable);

            return base.patch(id, patch, expectedTable);
        },
        query: (tableName: string) => {
            guardTable(tableName);

            return base.query(tableName);
        },
        rank: (tableName: string, indexName: string, options: unknown) => {
            guardTable(tableName);

            return base.rank(tableName, indexName, options);
        },
        rankPage: (tableName: string, indexName: string, options?: unknown) => {
            guardTable(tableName);

            return base.rankPage(tableName, indexName, options);
        },
        replace: async (id: string, document: unknown, expectedTable?: string) => {
            await guardById(id, expectedTable);

            return base.replace(id, document, expectedTable);
        },
    };

    if (baseRankBefore) {
        guarded["rankBefore"] = (tableName: string, indexName: string, options: unknown) => {
            guardTable(tableName);

            return baseRankBefore(tableName, indexName, options);
        };
    }

    return guarded as unknown as W;
};

export { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError };
