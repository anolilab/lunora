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
import { LunoraError } from "@lunora/errors";

/**
 * Well-known symbol the guard hangs the unwrapped writer off of. `Symbol.for`
 * (the cross-realm global registry) lets `@lunora/server`'s RLS middleware read
 * it WITHOUT importing this module — both sides reference the same registered
 * symbol by key, dodging a `server → do` dependency.
 */
const RLS_UNWRAP_SYMBOL: symbol = Symbol.for("lunora.ctxdb.rls-unwrap");

/**
 * Thrown when a raw (non-RLS) handler touches a protected table under a
 * `.rls("required")` schema. A `LunoraError` subclass (`code: "RLS_REQUIRED"`,
 * `status: 403`) recognised structurally across packages (via `isLunoraError`) —
 * which deliberately avoid a hard `@lunora/do` runtime dependency — without an
 * `instanceof` check. `table` is kept as an own property.
 */
class RlsRequiredError extends LunoraError {
    public readonly table: string;

    public constructor(table: string) {
        super(
            "RLS_REQUIRED",
            `ctx.db access to "${table}" is denied: the schema is marked .rls("required"), so this table is protected. ` +
                `Apply RLS with .use(rls(policies)) in the procedure, or mark the table .public() to opt it out.`,
            { name: "RlsRequiredError" },
        );
        this.table = table;
    }
}

/** Minimal schema projection the guard reads: the RLS mode + per-table opt-out and shard mode. */
interface GuardableSchema {
    readonly rlsMode?: "required";
    readonly tables: Record<string, { readonly isPublic?: boolean; readonly shardMode?: { readonly kind?: string } }>;
}

/**
 * Resolve the owning table of a row id (so a generic `ctx.db.get(id)` with no
 * pinned table can still be gated). May be sync (DO `locateRowById`) or async (D1
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
    delete: (id: string, expectedTable?: string, options?: { hard?: boolean }) => unknown;
    deleteAll?: (tableName: string, options?: { chunkSize?: number; hard?: boolean }) => unknown;
    deleteMany: (ids: ReadonlyArray<string>, options?: { limit?: number }, expectedTable?: string) => unknown;
    deleteWhere?: (tableName: string, where: Record<string, unknown>, options?: { limit?: number }) => unknown;
    findFirst: (tableName: string, args?: unknown) => unknown;
    findFirstOrThrow: (tableName: string, args?: unknown) => unknown;
    findMany: (tableName: string, args?: unknown) => unknown;
    get: (id: string, expectedTable?: string) => unknown;
    groupBy: (tableName: string, options: unknown) => unknown;
    insert: (tableName: string, document: unknown, options?: unknown) => unknown;
    insertMany: (tableName: string, documents: ReadonlyArray<Record<string, unknown>>, options?: { limit?: number; skipDuplicates?: boolean }) => unknown;
    insertManyUnsafe: (
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { allowExplicitId?: boolean; limit?: number },
    ) => unknown;
    patch: (id: string, patch: unknown, expectedTable?: string) => unknown;
    patchMany: (patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>, options?: { limit?: number }, expectedTable?: string) => unknown;
    patchWhere?: (tableName: string, args: { patch: Record<string, unknown>; where: Record<string, unknown> }, options?: { limit?: number }) => unknown;
    query: (tableName: string) => unknown;
    rank: (tableName: string, indexName: string, options: unknown) => unknown;
    rankBefore?: (tableName: string, indexName: string, options: unknown) => unknown;
    rankPage: (tableName: string, indexName: string, options?: unknown) => unknown;
    replace: (id: string, document: unknown, expectedTable?: string, options?: { allowExplicitId?: boolean }) => unknown;
    restore?: (id: string, expectedTable?: string) => unknown;
    wipeShard?: (options?: { chunkSize?: number; exclude?: ReadonlyArray<string>; tables?: ReadonlyArray<string> }) => unknown;
}

/** The tables a `wipeShard` sweep actually reaches — `.global()` tables are excluded. */
const shardLocalTableNames = (schema: GuardableSchema): string[] =>
    Object.entries(schema.tables)
        .filter(([, table]) => table.shardMode?.kind !== "global")
        .map(([name]) => name);

/**
 * Gate a whole-shard sweep: every table the sweep would touch must pass `guardTable`.
 *
 * Under `.rls("required")` that means any non-`.public()` table in range denies the
 * whole call — a shard-wide erase from a procedure that never engaged RLS is precisely
 * what secure-by-default exists to stop. Hoisted out of {@link guardWriter} so its own
 * complexity stays within budget.
 */
const guardShardSweep = (
    tables: ReadonlyArray<string>,
    options: { exclude?: ReadonlyArray<string>; tables?: ReadonlyArray<string> } | undefined,
    guardTable: (tableName: string) => void,
): void => {
    const requested = options?.tables;
    const excluded = new Set(options?.exclude);

    for (const tableName of tables) {
        const inRange = (requested === undefined || requested.includes(tableName)) && !excluded.has(tableName);

        if (inRange) {
            guardTable(tableName);
        }
    }
};

/**
 * The guarded forms of the two erase primitives, as a spreadable partial.
 *
 * Both are optional on {@link GuardableWriter} (the `.global()` twins omit them), and
 * both are destructive enough that the `...raw` spread must never expose them
 * unguarded. Built here rather than inline so {@link guardWriter} stays within its
 * complexity budget.
 */
const guardEraseMethods = (base: GuardableWriter, schema: GuardableSchema, guardTable: (tableName: string) => void): Record<string, unknown> => {
    const overrides: Record<string, unknown> = {};
    const { deleteAll, wipeShard } = base;

    if (deleteAll) {
        // Table-level gate, like `deleteWhere` — this is the most destructive method
        // on the writer.
        overrides["deleteAll"] = (tableName: string, options?: { chunkSize?: number; hard?: boolean }) => {
            guardTable(tableName);

            return deleteAll(tableName, options);
        };
    }

    if (wipeShard) {
        overrides["wipeShard"] = (options?: { chunkSize?: number; exclude?: ReadonlyArray<string>; tables?: ReadonlyArray<string> }) => {
            // Denied outright while any swept table is protected — erase from an
            // admin/system writer (built without `enforceRls`) instead.
            //
            // Only the tables `wipeShard` actually touches are gated. It skips
            // `.global()` tables by design (their rows live in D1, shared across
            // shards), so gating them here would let a protected global table block a
            // wipe whose real, shard-local targets are all `.public()`.
            guardShardSweep(shardLocalTableNames(schema), options, guardTable);

            return wipeShard(options);
        };
    }

    return overrides;
};

/**
 * Wrap `raw` in the secure-by-default guard. A no-op (returns `raw` untouched)
 * unless the schema is `.rls("required")` — so non-secure schemas pay nothing
 * and keep identical behavior. The returned writer is the SAME runtime shape as
 * `raw` (every non-gated method copied through) plus {@link RLS_UNWRAP_SYMBOL}
 * pointing back at `raw`.
 */
// The generic is intentionally UNCONSTRAINED (not `W extends GuardableWriter`):
// the concrete `DatabaseWriterLike` carries exact option types (e.g.
// `aggregate(options: AggregateOptions)`) that don't satisfy this module's loose
// `unknown`-typed surface under contravariant property checks. Constraining here
// would reject the real writer and erase its extra members (`normalizeId`, …)
// from the return type. Instead we keep `W` opaque — preserving the caller's
// concrete type through the return — and reach the guardable surface via a cast.
const guardWriter = <W>(raw: W, schema: GuardableSchema, tableOfId: TableOfId): W => {
    if (schema.rlsMode !== "required") {
        return raw;
    }

    // Reach the guardable methods through the loose structural type; the runtime
    // object genuinely has them (it's the concrete writer).
    const base = raw as unknown as GuardableWriter;

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
        ...guardEraseMethods(base, schema, guardTable),
        [RLS_UNWRAP_SYMBOL]: raw,

        aggregate: (tableName: string, options: unknown) => {
            guardTable(tableName);

            return base.aggregate(tableName, options);
        },
        count: (tableName: string, whereOrArgs?: unknown) => {
            guardTable(tableName);

            return base.count(tableName, whereOrArgs);
        },
        delete: async (id: string, expectedTable?: string, options?: { hard?: boolean }) => {
            await guardById(id, expectedTable);

            return base.delete(id, expectedTable, options);
        },
        deleteMany: async (ids: ReadonlyArray<string>, options?: { limit?: number }, expectedTable?: string) => {
            // Gate every id like a single delete (a protected, policy-less row
            // can't be reached by bare id), then delegate the batch — which
            // enforces the payload cap downstream. `expectedTable` (the facade's
            // bound table) scopes each id, mirroring the single delete gate.
            for (const id of ids) {
                // eslint-disable-next-line no-await-in-loop -- per-id table resolution mirrors the single delete gate
                await guardById(id, expectedTable);
            }

            return base.deleteMany(ids, options, expectedTable);
        },
        deleteWhere: base.deleteWhere
            ? async (tableName: string, where: Record<string, unknown>, options?: { limit?: number }) => {
                  // Where-based: gate the table, then delegate. Per-row policy
                  // checks happen in the RLS middleware layer above this guard.
                  guardTable(tableName);

                  return await base.deleteWhere?.(tableName, where, options);
              }
            : undefined,
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
        insertMany: (tableName: string, documents: ReadonlyArray<Record<string, unknown>>, options?: { limit?: number; skipDuplicates?: boolean }) => {
            // Every row targets the same table, so one table-level guard covers
            // the batch; the payload cap is enforced by the delegated writer.
            guardTable(tableName);

            return base.insertMany(tableName, documents, options);
        },
        insertManyUnsafe: (tableName: string, documents: ReadonlyArray<Record<string, unknown>>, options?: { allowExplicitId?: boolean; limit?: number }) => {
            // "Unsafe" skips validators/triggers, NOT the guard: the table-level
            // secure-by-default check still runs (the spread in this writer would
            // otherwise expose the raw method unguarded).
            guardTable(tableName);

            return base.insertManyUnsafe(tableName, documents, options);
        },
        patch: async (id: string, patch: unknown, expectedTable?: string) => {
            await guardById(id, expectedTable);

            return base.patch(id, patch, expectedTable);
        },
        patchMany: async (patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>, options?: { limit?: number }, expectedTable?: string) => {
            // `expectedTable` (the facade's bound table) scopes each id, mirroring the single patch gate.
            for (const entry of patches) {
                // eslint-disable-next-line no-await-in-loop -- per-id table resolution mirrors the single patch gate
                await guardById(entry.id, expectedTable);
            }

            return base.patchMany(patches, options, expectedTable);
        },
        patchWhere: base.patchWhere
            ? async (tableName: string, args: { patch: Record<string, unknown>; where: Record<string, unknown> }, options?: { limit?: number }) => {
                  // Where-based: gate the table, then delegate. Per-row policy
                  // checks happen in the RLS middleware layer above this guard.
                  guardTable(tableName);

                  return await base.patchWhere?.(tableName, args, options);
              }
            : undefined,
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
        replace: async (id: string, document: unknown, expectedTable?: string, options?: { allowExplicitId?: boolean }) => {
            await guardById(id, expectedTable);

            return base.replace(id, document, expectedTable, options);
        },
        restore: async (id: string, expectedTable?: string) => {
            // Restore is a by-id write (clears the soft-delete marker); gate it
            // like patch so a protected, policy-less row can't be un-deleted
            // through the raw method the `...raw` spread would otherwise expose.
            await guardById(id, expectedTable);

            return base.restore?.(id, expectedTable);
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
