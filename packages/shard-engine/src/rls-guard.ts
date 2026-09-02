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

import type { DatabaseWriterLike } from "./schema-types";

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
 * Batched sibling of {@link TableOfId} for `deleteMany`/`patchMany`: resolve
 * the owning table of MANY ids in one call instead of one {@link TableOfId}
 * call per id. Optional — a caller (e.g. the D1/`.global()` twin) that has no
 * batch-probe primitive simply omits it, and {@link guardWriter}'s batch
 * methods fall back to the existing per-id loop unchanged. The returned map
 * carries only RESOLVED ids; an id absent from it is treated exactly like a
 * {@link TableOfId} `undefined` — unresolved, so it leaks nothing and passes
 * through.
 */
type TablesOfIds = (ids: ReadonlyArray<string>, expectedTable?: string) => Promise<ReadonlyMap<string, string>> | ReadonlyMap<string, string>;

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
    lookupById?: (id: string, expectedTable?: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
    patch: (id: string, patch: unknown, expectedTable?: string) => unknown;
    patchMany: (patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>, options?: { limit?: number }, expectedTable?: string) => unknown;
    patchWhere?: (tableName: string, args: { patch: Record<string, unknown>; where: Record<string, unknown> }, options?: { limit?: number }) => unknown;
    query: (tableName: string) => unknown;
    rank: (tableName: string, indexName: string, options: unknown) => unknown;
    rankBefore?: (tableName: string, indexName: string, options: unknown) => unknown;
    rankPage: (tableName: string, indexName: string, options?: unknown) => unknown;
    rankPageRows?: (tableName: string, indexName: string, options?: unknown) => unknown;
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

/** How {@link guardWriter} gates one method of the real writer. */
type WriterGating =
    /** By-id write/read: the owning table is resolved from the id, then gated (`guardById`). */
    | "id-gated"
    /** Table-first, but overridden inline rather than by the uniform loop — its key must exist (as `undefined`) even when the base has no implementation. */
    | "inline-table-gated"
    /** Whole-shard sweep: every table in range is gated (`guardShardSweep`). */
    | "sweep-gated"
    /** First argument is the table name: gated by the one uniform table-level check below. */
    | "table-first"
    /** Deliberately NOT gated — see the reason on each entry. */
    | "ungated";

/**
 * How the guard treats EVERY method of the real `DatabaseWriterLike`.
 *
 * This is the exhaustiveness control: the key type is `keyof DatabaseWriterLike`,
 * so a method ADDED to the real writer fails to compile here until it is
 * classified, and a method removed fails too. Before this map, both the gated
 * list below and the unit test's fake writer were hand-maintained and nothing
 * compared them to the writer — `insertMany`/`insertManyUnsafe` were gated in
 * source but unreachable in the test, so deleting them from the list left the
 * suite green.
 *
 * `"ungated"` entries are an explicit allowlist WITH a reason, never an
 * omission: each one either touches no rows or is a pure string helper.
 */
const WRITER_METHOD_GATING: Readonly<Record<keyof DatabaseWriterLike, WriterGating>> = {
    aggregate: "table-first",
    /** Pure id formatter — composes a string from `(tableName, id)`, reads and writes nothing. */
    asId: "ungated",
    /** Metadata-only changelog probe: returns table NAMES and a cursor, never a document. */
    cdcChangedTables: "ungated",
    count: "table-first",
    delete: "id-gated",
    deleteAll: "table-first",
    deleteMany: "id-gated",
    deleteWhere: "inline-table-gated",
    findFirst: "table-first",
    findFirstOrThrow: "table-first",
    findMany: "table-first",
    get: "id-gated",
    groupBy: "table-first",
    insert: "table-first",
    insertMany: "table-first",
    insertManyUnsafe: "table-first",
    lookupById: "id-gated",
    /** Pure id validator/parser — returns the id or `null`, reads no row. */
    normalizeId: "ungated",
    patch: "id-gated",
    patchMany: "id-gated",
    patchWhere: "inline-table-gated",
    query: "table-first",
    rank: "table-first",
    rankBefore: "table-first",
    rankPage: "table-first",
    rankPageRows: "table-first",
    replace: "id-gated",
    restore: "id-gated",
    /** The system-table reader: reserved tables, not user tables, so the per-table policy model does not apply. */
    system: "ungated",
    wipeShard: "sweep-gated",
};

/**
 * Every method whose FIRST argument is the table name, gated by one uniform
 * table-level check — DERIVED from {@link WRITER_METHOD_GATING} so the two can
 * never drift. Includes the optional members (`deleteAll`, `rankBefore`,
 * `rankPageRows`) — a base without them simply isn't overridden, so they stay
 * absent on the guarded writer exactly as the `...raw` spread left them.
 */
const TABLE_FIRST_METHODS: ReadonlyArray<keyof DatabaseWriterLike> = Object.entries(WRITER_METHOD_GATING)
    .filter(([, gating]) => gating === "table-first")
    .map(([name]) => name as keyof DatabaseWriterLike);

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
const guardWriter = <W>(raw: W, schema: GuardableSchema, tableOfId: TableOfId, tablesOfIds?: TablesOfIds): W => {
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

    /**
     * The `deleteMany`/`patchMany` gate: same decision as {@link guardById}
     * applied to every id in the batch, but fetching table ownership in as
     * few round-trips as possible instead of one probe per id.
     *
     * - `expectedTable` pinned (the by-id facade's bound table) → one
     * `guardTable` call, no probe at all — identical to the single-id path.
     * - No {@link tablesOfIds} resolver supplied (the D1/`.global()` twin
     * hasn't implemented the batch form) → fall back to the per-id loop,
     * verbatim.
     * - Otherwise: dedupe, resolve the owning table of every id in ONE call,
     * then judge each id (in its original, possibly-duplicated input order)
     * through the same {@link guardTable} — an unresolved id passes through
     * exactly like {@link guardById}'s bare-id case.
     */
    const guardByIds = async (ids: ReadonlyArray<string>, expectedTable?: string): Promise<void> => {
        if (expectedTable !== undefined) {
            guardTable(expectedTable);

            return;
        }

        if (!tablesOfIds) {
            for (const id of ids) {
                // eslint-disable-next-line no-await-in-loop -- no batch resolver supplied (D1-twin fallback): mirrors the pre-batch per-id loop verbatim
                await guardById(id, expectedTable);
            }

            return;
        }

        const resolved = await tablesOfIds([...new Set(ids)], expectedTable);

        for (const id of ids) {
            const tableName = resolved.get(id);

            if (tableName !== undefined) {
                guardTable(tableName);
            }
        }
    };

    const guarded: Record<PropertyKey, unknown> = {
        ...(raw as Record<string, unknown>),
        [RLS_UNWRAP_SYMBOL]: raw,

        delete: async (id: string, expectedTable?: string, options?: { hard?: boolean }) => {
            await guardById(id, expectedTable);

            return base.delete(id, expectedTable, options);
        },
        deleteMany: async (ids: ReadonlyArray<string>, options?: { limit?: number }, expectedTable?: string) => {
            // Gate every id like a single delete (a protected, policy-less row
            // can't be reached by bare id), then delegate the batch — which
            // enforces the payload cap downstream. `expectedTable` (the facade's
            // bound table) scopes each id, mirroring the single delete gate.
            await guardByIds(ids, expectedTable);

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
        get: async (id: string, expectedTable?: string) => {
            await guardById(id, expectedTable);

            return base.get(id, expectedTable);
        },
        lookupById: async (id: string, expectedTable?: string) => {
            // The spread would otherwise expose the raw lookup, letting a bare id
            // read any row in any table past the table-level secure-by-default check.
            await guardById(id, expectedTable);

            // eslint-disable-next-line unicorn/no-null -- mirrors the seam's own `null`-for-absent contract
            return base.lookupById?.(id, expectedTable) ?? null;
        },
        patch: async (id: string, patch: unknown, expectedTable?: string) => {
            await guardById(id, expectedTable);

            return base.patch(id, patch, expectedTable);
        },
        patchMany: async (patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>, options?: { limit?: number }, expectedTable?: string) => {
            // `expectedTable` (the facade's bound table) scopes each id, mirroring the single patch gate.
            await guardByIds(
                patches.map((entry) => entry.id),
                expectedTable,
            );

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

    // One uniform gate for every table-name-first method, `insertManyUnsafe`
    // and `deleteAll` included — "unsafe" skips validators/triggers, NOT the
    // guard, and the `...raw` spread must never expose a destructive raw
    // method unguarded. A batch (`insertMany`) needs only this one table-level
    // check: every row targets the same table, and the payload cap is enforced
    // by the delegated writer.
    const methods = base as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;

    for (const name of TABLE_FIRST_METHODS) {
        const method = methods[name];

        if (typeof method === "function") {
            guarded[name] = (tableName: string, ...rest: unknown[]) => {
                guardTable(tableName);

                return method.call(base, tableName, ...rest);
            };
        }
    }

    if (base.wipeShard) {
        const { wipeShard } = base;

        guarded["wipeShard"] = (options?: { chunkSize?: number; exclude?: ReadonlyArray<string>; tables?: ReadonlyArray<string> }) => {
            // Denied outright while any swept table is protected — erase from an
            // admin/system writer (built without `enforceRls`) instead.
            //
            // Only the tables `wipeShard` actually touches are gated. It skips
            // `.global()` tables by design (their rows live in D1, shared across
            // shards), so gating them here would let a protected global table block a
            // wipe whose real, shard-local targets are all `.public()`.
            guardShardSweep(shardLocalTableNames(schema), options, guardTable);

            return wipeShard.call(base, options);
        };
    }

    return guarded as unknown as W;
};

export { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError, TABLE_FIRST_METHODS, WRITER_METHOD_GATING };
export type { WriterGating };
