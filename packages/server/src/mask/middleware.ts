/**
 * `mask(policies)` — the procedure-builder middleware that activates Dynamic
 * Data Masking for the downstream handler. The column-level analogue of
 * `rls(policies)` (`../rls/middleware`): RLS filters which **rows** a caller
 * sees; masking transforms which **column values** are returned in the clear.
 *
 * What it does, at runtime:
 *
 * 1. **Reads** — wraps the row-returning readers (`findMany` / `findFirst` /
 * `findFirstOrThrow` / `get` / `query` / `rankPage`). For every **top-level**
 * row of a masked table, each declared column is rewritten by its strategy
 * (`"redact"` → `null`, `"hash"` → a stable non-reversible token, or a custom
 * `MaskFn`). The stored row is never touched — only the value handed back.
 *
 * **Limitation — nested `with` relations are NOT masked.** Masking rewrites the
 * rows of the table named in the call (`ctx.db.posts.findMany(...)` masks
 * `posts`). Rows pulled in as a relation via `with` are hydrated below the
 * `ctx.db` facade by `@lunora/do`'s relation fetcher, on a path this middleware
 * never sees — so `ctx.db.posts.findMany({ with: { author: true } })` returns
 * each `author` in the clear even if `users` is masked. This mirrors RLS, whose
 * row filter likewise does not descend into `with`-hydrated children. If a
 * relation can surface PII, mask it at its own read site or gate the relation
 * with `rls()` rather than relying on the parent's mask.
 *
 * 2. **Analytical reductions fail closed** — `aggregate` / `groupBy` over a
 * masked column throw `LunoraError("MASK_UNSUPPORTED")`: a group key *is* the
 * raw value and an aggregate is computed *from* it, so neither can be served
 * without leaking what the mask hides. `count` / `rank` / `rankBefore` return
 * counts-of-rows (no column value), so they pass through. `rankPage` returns
 * rows, so its page is masked like `findMany`.
 *
 * 3. **Writes pass through untouched** — `insert` / `patch` / `replace` /
 * `delete` are never wrapped, so masking can't corrupt stored data. Masking is
 * an output filter, full stop.
 *
 * 4. **Opt-in scope** — a mask applies only inside procedures whose builder
 * chain includes this middleware. A procedure without `.use(mask(...))` sees
 * the unwrapped `ctx.db`. Internal procedures (`internalQuery` / … ) therefore
 * bypass masking simply by not adding it — trusted server-side reads see clear
 * data, exactly as they bypass RLS.
 *
 * 5. **Fail closed** — a `MaskFn` that throws redacts the cell to `null` rather
 * than leak the raw value.
 *
 * Signature-compatible with the builder's `Middleware&lt;>`, so `.use(mask(...))`
 * slots in like any other middleware. Composes with `rls()` in either order:
 * each wraps `ctx.db` and forwards it via `next({ ctx: { db } })`, so
 * `.use(rls(...)).use(mask(...))` yields rows that are both row-filtered and
 * column-masked.
 */
import type { Middleware } from "../builder/types";
import { LunoraError } from "../error";
import type { FacadeEntry } from "../facade";
import { bindOrm, bindTableFacade } from "../facade";
import type { MaskColumns, MaskContext, MaskOptions, MaskPolicies, Permission, Role } from "./types";

interface QueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

interface QueryArgs {
    baseWhere?: unknown;
    cursor?: null | string;
    limit?: number;
    where?: unknown;
    with?: Record<string, unknown>;
}

interface AggregateArgs {
    field?: string;
    op: string;
}

interface GroupByArgs {
    agg?: { field?: string; op: string };
    by: ReadonlyArray<string>;
}

interface TableReaderLike {
    collect: () => Promise<Record<string, unknown>[]>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReaderLike;
    first: () => Promise<Record<string, unknown> | null>;
    order: (direction: "asc" | "desc") => TableReaderLike;
    paginate: (options: { cursor?: null | string; numItems: number }) => Promise<QueryPage>;
    take: (limit: number) => Promise<Record<string, unknown>[]>;
    unique: () => Promise<Record<string, unknown> | null>;
    withIndex: (indexName: string, range?: (q: unknown) => unknown) => TableReaderLike;
    withSearchIndex: (indexName: string, search: (q: unknown) => unknown) => TableReaderLike;
}

/**
 * Structural projection of the runtime ORM writer — the same subset
 * `../rls/middleware` mirrors, so the wrapper is interchangeable between
 * `@lunora/do`'s and `@lunora/d1`'s `DatabaseWriterLike` without an
 * inter-package dependency. `rankBefore` is optional (the D1 twin omits it).
 */
interface MaskDatabase {
    aggregate: (tableName: string, options: AggregateArgs) => Promise<null | number>;
    count: (tableName: string, whereOrArgs?: unknown) => Promise<number>;
    delete: (id: string, expectedTable?: string) => Promise<void>;
    deleteMany: (ids: ReadonlyArray<string>, options?: { limit?: number }) => Promise<{ deleted: number }>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;
    get: (id: string, expectedTable?: string) => Promise<Record<string, unknown> | null>;
    groupBy: (tableName: string, options: GroupByArgs) => Promise<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    insertMany: (tableName: string, documents: ReadonlyArray<Record<string, unknown>>, options?: { limit?: number }) => Promise<string[]>;
    lookupById?: (id: string, expectedTable?: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
    patch: (id: string, patch: Record<string, unknown>, expectedTable?: string) => Promise<void>;
    patchMany: (patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>, options?: { limit?: number }) => Promise<void>;
    query: (tableName: string) => TableReaderLike;
    rank: (tableName: string, indexName: string, options: unknown) => Promise<null | { position: number; total: number }>;
    rankBefore?: (tableName: string, indexName: string, options: unknown) => Promise<{ before: number; total: number }>;
    rankPage: (tableName: string, indexName: string, options?: unknown) => Promise<QueryPage>;
    replace: (id: string, document: Record<string, unknown>, expectedTable?: string) => Promise<void>;
}

/** Roles list source on the context. Tolerant of older auth states (mirrors RLS's `AuthLike`). */
type AuthLike = {
    getIdentity?: () => Promise<Record<string, unknown> | null>;
    roles?: ReadonlyArray<string>;
    userId?: null | string;
};

interface MaskContextIn {
    auth?: AuthLike;
    db: MaskDatabase;
}

const permissionName = (permission: Permission | string): string => (typeof permission === "string" ? permission : permission.name);

/** Build a `roleName → granted-permission-names` index (mirrors RLS / storage-rules). */
const indexRolePermissions = (roles: ReadonlyArray<Role> | undefined): Map<string, ReadonlySet<string>> => {
    const map = new Map<string, ReadonlySet<string>>();

    for (const role of roles ?? []) {
        map.set(role.name, new Set((role.permissions ?? []).map((permission) => permissionName(permission))));
    }

    return map;
};

/**
 * FNV-1a (32-bit) digest as 8-char hex — the `"hash"` strategy's token. A fast,
 * deterministic, NON-cryptographic hash: same input → same token, so a hashed
 * column stays joinable/groupable on the client.
 *
 * SECURITY: this is NOT a confidentiality control. It is unsalted, deterministic
 * and narrow (~2^32 outputs), so a low-entropy input (email / phone / SSN) is
 * brute-force-recoverable by the same caller the mask is meant to blind, and
 * equal values always yield equal tokens (cross-row/tenant correlation). The
 * `"hash"` strategy exists for stable pseudonymous grouping/joining ONLY; PII
 * that must stay hidden must use `"redact"`. See `MaskStrategy` docs.
 * `Math.imul` keeps the multiply in 32-bit space.
 */
const fnv1aHex = (input: string): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and an unsigned shift; the bit ops ARE the algorithm */
    let hash = 0x81_1c_9d_c5;

    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.codePointAt(index) ?? 0;
        hash = Math.imul(hash, 0x01_00_01_93);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
    /* eslint-enable no-bitwise */
};

/**
 * Apply one column strategy to one cell value. **Fails closed**: any thrown
 * error (a custom `MaskFn` that blows up, a non-serialisable value handed to
 * `"hash"`) redacts to `null` rather than leak the raw value.
 */
const applyStrategy = <Context>(strategy: MaskColumns<Context>[string], value: unknown, context: MaskContext<Context>): unknown => {
    try {
        if (strategy === "redact") {
            // eslint-disable-next-line unicorn/no-null -- redaction drops the cell to the null sentinel
            return null;
        }

        if (strategy === "hash") {
            if (value === null || value === undefined) {
                return value;
            }

            return fnv1aHex(typeof value === "string" ? value : JSON.stringify(value));
        }

        return strategy(value, context);
    } catch {
        // eslint-disable-next-line unicorn/no-null -- fail closed: a throwing strategy must never surface the raw value
        return null;
    }
};

/**
 * Return a shallow copy of `row` with each masked column rewritten by its
 * strategy. Columns absent on the row are skipped. The per-cell context carries
 * the ORIGINAL row (not the partially-masked copy) so a `MaskFn` branching on a
 * sibling column sees clear data.
 */
const maskRow = <Context>(row: Record<string, unknown>, columns: MaskColumns<Context>, base: MaskContext<Context>): Record<string, unknown> => {
    const out = { ...row };

    for (const [column, strategy] of Object.entries(columns)) {
        if (!(column in out)) {
            continue;
        }

        out[column] = applyStrategy(strategy, row[column], { ...base, column, row });
    }

    return out;
};

const maskPage = <Context>(page: QueryPage, columns: MaskColumns<Context>, base: MaskContext<Context>): QueryPage => {
    return { ...page, page: page.page.map((row) => maskRow(row, columns, base)) };
};

/**
 * A value glued onto `ctx.db` is a per-table facade entry when it carries the
 * `findMany` + `withSearchIndex` accessor pair (mirrors RLS's check). Used to
 * find the entries that need re-binding through the masked writer.
 */
const isFacadeEntry = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, unknown>;

    return typeof candidate["findMany"] === "function" && typeof candidate["withSearchIndex"] === "function";
};

/**
 * Build a writer that masks row-returning reads against the underlying
 * `MaskDatabase`. Fresh closure per request so each `MaskFn` sees the live ctx.
 */
const wrapDatabase = <Context>(base: MaskDatabase, perTable: Map<string, MaskColumns<Context>>, context: MaskContext<Context>): MaskDatabase => {
    /**
     * Wrap a `query()` reader so every terminal read (`collect` / `first` /
     * `unique` / `take` / `paginate`) masks its rows, and every chainable
     * refinement (`filter` / `order` / `withIndex` / `withSearchIndex`) returns a
     * reader that is still masked.
     */
    const wrapReader = (reader: TableReaderLike, columns: MaskColumns<Context>): TableReaderLike => {
        return {
            collect: async () => {
                const rows = await reader.collect();

                return rows.map((row) => maskRow(row, columns, context));
            },
            filter: (predicate) =>
                wrapReader(
                    reader.filter((document) => predicate(document)),
                    columns,
                ),
            first: async () => {
                const row = await reader.first();

                // eslint-disable-next-line unicorn/no-null -- mirrors the reader's `null` empty sentinel
                return row ? maskRow(row, columns, context) : null;
            },
            order: (direction) => wrapReader(reader.order(direction), columns),
            paginate: async (options) => maskPage(await reader.paginate(options), columns, context),
            take: async (limit) => {
                const rows = await reader.take(limit);

                return rows.map((row) => maskRow(row, columns, context));
            },
            unique: async () => {
                const row = await reader.unique();

                // eslint-disable-next-line unicorn/no-null -- mirrors the reader's `null` empty sentinel
                return row ? maskRow(row, columns, context) : null;
            },
            withIndex: (indexName, range) => wrapReader(reader.withIndex(indexName, range), columns),
            withSearchIndex: (indexName, search) => wrapReader(reader.withSearchIndex(indexName, search), columns),
        };
    };

    /**
     * Resolve the raw row for an id and which masked table (if any) owns it.
     * `get(id)`/the id-keyed facade carry no table name, so — like RLS's
     * `locateRow` — we use the optional `lookupById` fast path, else fetch the
     * row and probe the masked tables concurrently. Only masked tables are
     * probed: a row in no masked table needs no masking. The unwrapped `base.*`
     * is used so the probe itself isn't masked.
     */
    const locate = async (id: string, expectedTable?: string): Promise<{ row: null | Record<string, unknown>; tableName: string | undefined }> => {
        if (base.lookupById) {
            // Pin the lookup to the bound table when the by-id facade forwards
            // one, so a foreign id can't read another table's row around the
            // mask (IDOR).
            const located = await base.lookupById(id, expectedTable);

            if (!located) {
                // eslint-disable-next-line unicorn/no-null -- absent row mirrors @lunora/do's writer null sentinel
                return { row: null, tableName: undefined };
            }

            return { row: located.row, tableName: perTable.has(located.tableName) ? located.tableName : undefined };
        }

        const row = await base.get(id, expectedTable);

        if (!row) {
            // eslint-disable-next-line unicorn/no-null -- absent row mirrors @lunora/do's writer null sentinel
            return { row: null, tableName: undefined };
        }

        let probeTables: string[];

        if (expectedTable === undefined) {
            probeTables = [...perTable.keys()];
        } else if (perTable.has(expectedTable)) {
            probeTables = [expectedTable];
        } else {
            probeTables = [];
        }
        const probes = await Promise.all(
            probeTables.map(async (tableName) => {
                const probe = await base.findFirst(tableName, { limit: 1, where: { _id: id } });

                return probe?.["_id"] === id ? tableName : undefined;
            }),
        );

        return { row, tableName: probes.find((entry): entry is string => entry !== undefined) };
    };

    /** Fail an analytical reduction closed when it touches a masked column on `tableName`. */
    const assertReductionAllowed = (tableName: string, fields: ReadonlyArray<string | undefined>, method: string): void => {
        const columns = perTable.get(tableName);

        if (!columns) {
            return;
        }

        const offending = fields.find((field): field is string => typeof field === "string" && field in columns);

        if (offending !== undefined) {
            throw new LunoraError("MASK_UNSUPPORTED", `${method}() over masked column "${offending}" on "${tableName}" is not supported`);
        }
    };

    const wrapped: MaskDatabase = {
        ...base,

        aggregate(tableName, options) {
            assertReductionAllowed(tableName, [options.field], "aggregate");

            return base.aggregate(tableName, options);
        },

        async findFirst(tableName, args) {
            const row = await base.findFirst(tableName, args);
            const columns = perTable.get(tableName);

            return row && columns ? maskRow(row, columns, context) : row;
        },

        async findFirstOrThrow(tableName, args) {
            const row = await base.findFirstOrThrow(tableName, args);
            const columns = perTable.get(tableName);

            return columns ? maskRow(row, columns, context) : row;
        },

        async findMany(tableName, args) {
            const page = await base.findMany(tableName, args);
            const columns = perTable.get(tableName);

            return columns ? maskPage(page, columns, context) : page;
        },

        async get(id, expectedTable) {
            const { row, tableName } = await locate(id, expectedTable);
            const columns = tableName === undefined ? undefined : perTable.get(tableName);

            if (!row || !columns) {
                return row;
            }

            return maskRow(row, columns, context);
        },

        groupBy(tableName, options) {
            assertReductionAllowed(tableName, [...options.by, options.agg?.field], "groupBy");

            return base.groupBy(tableName, options);
        },

        query(tableName) {
            const reader = base.query(tableName);
            const columns = perTable.get(tableName);

            return columns ? wrapReader(reader, columns) : reader;
        },

        async rankPage(tableName, indexName, options) {
            const page = await base.rankPage(tableName, indexName, options);
            const columns = perTable.get(tableName);

            return columns ? maskPage(page, columns, context) : page;
        },
    };

    // SECURITY: the generated runtime glues a per-table facade
    // (`ctx.db.users.findMany(...)`) onto `ctx.db`, bound to the UNWRAPPED
    // writer. The `...base` spread copies those raw-bound accessors verbatim, so
    // without this loop a masked table's facade would read around the mask. Re-
    // bind the masked tables through the wrapped writer using the SAME
    // `bindTableFacade` codegen emits, so the two can't drift. Only MASKED
    // tables are re-bound (a non-masked entry, including a `.global()` D1-bound
    // one, must keep its original binding).
    const writableFacade = wrapped as unknown as Record<string, unknown>;

    for (const tableName of perTable.keys()) {
        if (isFacadeEntry((base as unknown as Record<string, unknown>)[tableName])) {
            writableFacade[tableName] = bindTableFacade(wrapped, tableName);
        }
    }

    return wrapped;
};

/**
 * Procedure-builder middleware. Apply per-request via `.use(mask(policies))`.
 * Closes over the policy map at builder-construction time; resolves identity +
 * the `bypass` decision per call against the live ctx.
 *
 * IMPORTANT: a mask is in scope only for procedures whose builder chain
 * includes this middleware — opt-in, never global (the same invariant as RLS).
 */
const mask = <Context extends MaskContextIn = MaskContextIn>(
    policies: MaskPolicies<Context>,
    options: MaskOptions<Context> = {},
): Middleware<Context, Context> => {
    const perTable = new Map<string, MaskColumns<Context>>(Object.entries(policies));
    const rolePermissions = indexRolePermissions(options.roles);

    return async ({ ctx, next }) => {
        const auth = ctx.auth ?? {};
        // eslint-disable-next-line unicorn/no-null -- MaskContext.auth.identity carries `null` for the anonymous/no-resolver case
        const identity = (await auth.getIdentity?.()) ?? null;
        const roles = auth.roles ?? [];

        const granted = new Set<string>();

        for (const roleName of roles) {
            for (const name of rolePermissions.get(roleName) ?? []) {
                granted.add(name);
            }
        }

        const maskContext: MaskContext<Context> = {
            auth: {
                can: (permission) => granted.has(permissionName(permission)),
                identity,
                roles,
                // eslint-disable-next-line unicorn/no-null -- MaskContext.auth.userId is a public `null | string` type
                userId: auth.userId ?? null,
            },
            ctx,
        };

        // Procedure-wide escape hatch: a privileged caller sees raw values, so
        // we forward the unwrapped ctx untouched (no wrap, no facade rebind).
        if (options.bypass?.(maskContext)) {
            return next();
        }

        const wrapped = wrapDatabase<Context>(ctx.db, perTable, maskContext);
        const extension: Record<string, unknown> = { db: wrapped };
        const { orm } = ctx as { orm?: unknown };

        if (orm !== null && typeof orm === "object") {
            // `wrapped` carries the re-bound masked-table facade entries, so
            // rebuilding the orm over it routes `ctx.orm.query` reads through the
            // same mask. Same shared `bindOrm` codegen uses.
            extension.orm = bindOrm(wrapped as unknown as Record<string, FacadeEntry>);
        }

        return next({ ctx: extension });
    };
};

export { mask };
export type { MaskDatabase };
