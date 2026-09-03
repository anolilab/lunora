/**
 * `mask(policies)` — the procedure-builder middleware that activates Dynamic
 * Data Masking for the downstream handler. The column-level analogue of
 * `rls(policies)` (`../rls/middleware`): RLS filters which **rows** a caller
 * sees; masking transforms which **column values** are returned in the clear.
 *
 * What it does, at runtime:
 *
 * 1. **Reads** — wraps the row-returning readers (`findMany` / `findFirst` /
 * `findFirstOrThrow` / `get` / `query` / `rankPage`). For every row of a masked
 * table, each declared column is rewritten by its strategy (`"redact"` → `null`,
 * `"hash"` → a stable non-reversible token, or a custom `MaskFn`). The stored row
 * is never touched — only the value handed back.
 *
 * **`with` relations are masked too.** Rows pulled in as a relation are hydrated
 * below the `ctx.db` facade by the relation loader, on a path this middleware
 * never sees, so the mask is threaded down as a `relationMask` hook the loader
 * applies per hop with that hop's TARGET table — exactly how `rls()` threads
 * `relationBaseWhere`. `ctx.db.posts.findMany({ with: { author: true } })`
 * therefore masks each `author` by the `users` policy, at every nesting depth;
 * without it, chaining `with` reached masked columns on tables the caller could
 * not even name directly.
 *
 * The ONE hop a mask cannot follow is the cross-shard one — a `.global()` (D1)
 * parent loading a `.shardBy()` child, where nested rows are hydrated on the
 * serving shard and a mask policy (a closure over this request) cannot be sent
 * along. That case is REFUSED with `MASK_UNSUPPORTED` rather than served in the
 * clear; the hop's own rows still mask normally.
 *
 * 2. **Analytical reductions fail closed** — `aggregate` / `groupBy` over a
 * masked column throw `LunoraError("MASK_UNSUPPORTED")`: a group key *is* the
 * raw value and an aggregate is computed *from* it, so neither can be served
 * without leaking what the mask hides. `count` / `rank` / `rankBefore` /
 * `rankPage` return no column value, but a caller-reachable `where`/`baseWhere`
 * on any of them is a presence oracle the same way it is on a read, so all four
 * are guarded like `findMany` before delegating. `rankPage` additionally masks
 * its returned page like `findMany`.
 *
 * **Residual read-position oracles (no column value, but ordinal/sort leaks the
 * hidden value) — closed to different degrees:**
 * - A masked-column `where`/`baseWhere` filter on ANY read (including
 * `rank`/`rankBefore`/`rankPage` above) is closed — at ANY depth: the root
 * `where`, a relation predicate inside it (`{ author: { is: { ssn: … } } }`),
 * and every `with` hop's own `where`/`orderBy`. The engine honours a per-hop
 * predicate, so a returned-or-absent CHILD answers the same guess a root filter
 * would while the response column is dutifully `null`. Depth checks run even
 * when the ROOT table carries no mask (a `posts` read reaching a masked `users`).
 * - An index RANGE/SEARCH callback (`withIndex(name, q => …)`/
 * `withSearchIndex(...)`) referencing a masked column is closed
 * (`assertIndexFieldsAllowed`).
 * - A BARE `withIndex(name)` scan (no range callback) over an index whose
 * DECLARED fields include a masked column, a `rank`/`rankBefore`/`rankPage`
 * read over a rank index whose declared `sortBy`/`partitionBy` names a masked
 * column (`rankBefore`'s oracle is its `sortValues` argument, not `where` —
 * its real options carry no `where`/`baseWhere` at all), and a `withGeoIndex`
 * read over a geo index whose declared field is masked (its `near`/`within`
 * builder exposes no column name to a callback recorder, but the returned
 * rows are sorted by distance from the caller's own query point, which lets a
 * point/radius sweep trilaterate the hidden coordinate — the same shape of
 * oracle, over a `v.geoPoint()` column instead of a scalar), are all closed
 * by `assertIndexDeclarationAllowed` **when the caller supplies
 * `MaskOptions.indexFields`** (build it with the exported
 * `indexFieldsFromSchema(schema)`: `mask(policies, { indexFields:
 * indexFieldsFromSchema(schema) })`). This is OPT-IN and additive —
 * `indexFields` is optional, so a caller that doesn't pass it gets exactly
 * today's (un)protected behaviour; the oracle stays open until it does. Do
 * not rely on this closing for a table with a masked-sorted or masked-geo
 * index unless the mask actually supplies `indexFields`.
 * - `vectorIndexes` and `aggregateIndexes` are deliberately NOT part of this:
 * vector search isn't reachable through the masked reader (`TableReaderLike`
 * has no vector-search method), and an aggregate reduction is already guarded
 * column-by-column by `assertReductionAllowed` above. Neither is an ordinal
 * oracle this guard needs to cover.
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
 * Signature-compatible with the builder's `Middleware<>`, so `.use(mask(...))`
 * slots in like any other middleware. Composes with `rls()` in either order:
 * each wraps `ctx.db` and forwards it via `next({ ctx: { db } })`, so
 * `.use(rls(...)).use(mask(...))` yields rows that are both row-filtered and
 * column-masked.
 */
import { LunoraError } from "@lunora/errors";

import { fnv1aHex } from "../../../../shared/fnv1a";
import { isRelationPredicate } from "../../../../shared/relation-operators";
import type { Middleware } from "../builder/types";
import type { FacadeEntry } from "../facade";
import { bindOrm, bindTableFacade } from "../facade";
import { optionalWriterOverride } from "../optional-writer-override";
import type { ShardRankPageResultLike } from "../rank-page-rows-shape";
import type { AuthLike } from "../rls/middleware";
import { indexRolePermissions, isFacadeEntry, resolvePolicyAuth } from "../rls/middleware";
import type { IndexFieldsByTable } from "../schema";
import { tagMaskMiddleware } from "./policy-tag";
import type { MaskColumns, MaskContext, MaskOptions, MaskPolicies } from "./types";

interface QueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

interface QueryArgs {
    baseWhere?: unknown;
    cursor?: null | string;
    limit?: number;
    orderBy?: ReadonlyArray<Record<string, unknown>>;
    /** Per-target-table mask applied to `with`-hydrated children — mirrors `@lunora/shard-engine`'s `RelationMask`. */
    relationMask?: (table: string, rows: Record<string, unknown>[]) => Record<string, unknown>[];
    where?: unknown;
    with?: Record<string, unknown>;
}

interface AggregateArgs {
    field?: string;
    op: string;
    where?: unknown;
}

interface GroupByArgs {
    agg?: { field?: string; op: string };
    by: ReadonlyArray<string>;
    where?: unknown;
}

/** One row of a `.collectWithScores()` result — mirrors `@lunora/shard-engine`'s `ScoredDocument`. */
type ScoredDocument = GeoScoredDocument | SearchScoredDocument;

/** A `.withGeoIndex()` row — mirrors `@lunora/shard-engine`'s `GeoScoredDocument`. */
interface GeoScoredDocument {
    distanceMeters: null | number;
    document: Record<string, unknown>;
    score?: never;
}

/** A `.withSearchIndex()` row — mirrors `@lunora/shard-engine`'s `SearchScoredDocument`. */
interface SearchScoredDocument {
    distanceMeters?: never;
    document: Record<string, unknown>;
    score: number;
}

interface TableReaderLike {
    [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>>;
    collect: () => Promise<Record<string, unknown>[]>;
    collectWithScores: () => Promise<ScoredDocument[]>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReaderLike;
    first: () => Promise<Record<string, unknown> | null>;
    order: (direction: "asc" | "desc") => TableReaderLike;
    paginate: (options: { cursor?: null | string; numItems: number }) => Promise<QueryPage>;
    take: (limit: number) => Promise<Record<string, unknown>[]>;
    unique: () => Promise<Record<string, unknown> | null>;
    withGeoIndex: (indexName: string, build: (q: unknown) => unknown) => TableReaderLike;
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
    deleteWhere?: (tableName: string, where: Record<string, unknown>, options?: { limit?: number }) => Promise<{ deleted: number }>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;
    get: (id: string, expectedTable?: string) => Promise<Record<string, unknown> | null>;
    groupBy: (tableName: string, options: GroupByArgs) => Promise<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    insertMany: (
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { limit?: number; skipDuplicates?: boolean },
    ) => Promise<(string | null)[]>;
    lookupById?: (id: string, expectedTable?: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
    patch: (id: string, patch: Record<string, unknown>, expectedTable?: string) => Promise<void>;
    patchMany: (patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>, options?: { limit?: number }) => Promise<{ patched: number }>;
    patchWhere?: (
        tableName: string,
        args: { patch: Record<string, unknown>; where: Record<string, unknown> },
        options?: { limit?: number },
    ) => Promise<{ patched: number }>;
    query: (tableName: string) => TableReaderLike;
    rank: (tableName: string, indexName: string, options: unknown) => Promise<null | { position: number; total: number }>;
    rankBefore?: (tableName: string, indexName: string, options: unknown) => Promise<{ before: number; total: number }>;
    rankPage: (tableName: string, indexName: string, options?: unknown) => Promise<QueryPage>;
    /** Cross-shard companion to `rankPage`, gated the same way `rankPage` is masked below. */
    rankPageRows?: (tableName: string, indexName: string, options?: unknown) => Promise<ShardRankPageResultLike>;
    replace: (id: string, document: Record<string, unknown>, expectedTable?: string) => Promise<void>;
}

interface MaskContextIn {
    auth?: AuthLike;
    db: MaskDatabase;
}

/**
 * Apply one column strategy to one cell value. **Fails closed**: any thrown
 * error (a custom `MaskFn` that blows up, a non-serialisable value handed to
 * `"hash"`) redacts to `null` rather than leak the raw value.
 *
 * `"hash"` passes `null`/`undefined` through and hashes a `bigint` over its
 * decimal form (`123n` → `fnv1aHex("123")`) — `JSON.stringify` throws on a
 * bigint, so without the case a `v.bigint()` column would fail closed to `null`
 * instead of producing the stable token `"hash"` exists for. The digest itself is
 * `shared/fnv1a.ts`, shared with the studio's preview
 * (`packages/studio/src/lib/mask-preview.ts`) so the two cannot drift; that file
 * also carries the security caveats of `"hash"`.
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

            if (typeof value === "bigint") {
                return fnv1aHex(value.toString());
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
 * SECURITY (value oracle on the index path): `withIndex` / `withSearchIndex`
 * constrain WHICH rows are fetched by a caller-supplied range/search over a
 * column. If that column is masked, a caller can
 * `query(table).withIndex("by_ssn", q => q.eq("ssn", guess)).first()` — or the
 * search-index twin `q => q.search("email", term)` — and confirm / binary-search
 * the exact value the mask is meant to hide. It is the same oracle
 * `assertWhereAllowed` (below) closes on the `where` path, reached instead
 * through the index builder.
 *
 * Unlike `where` (a plain object walked by `collectWhereFields`), the
 * range/search is a builder CALLBACK (`q => q.eq("ssn", x)`), so the referenced
 * fields aren't statically inspectable. Run the callback once against a
 * recording proxy: its blanket `get` trap turns EVERY property access into a
 * method that captures its first positional argument — the field name is ALWAYS
 * the first argument of every builder method (`eq`/`gt`/`gte`/`lt`/`lte` on the
 * index range, `eq`/`search` on the search filter) — and returns a fresh
 * recorder so the chain (`q.eq(...).gt(...)`) keeps recording. Recording through
 * a blanket trap rather than a fixed method allow-list FAILS CLOSED: a
 * field-naming method added to the builder later still records its field with no
 * change here. Then reject if any recorded field is masked, mirroring
 * `assertWhereAllowed`'s message.
 *
 * The callback runs twice — here on the recorder, then on the real builder in
 * `reader.withIndex`/`withSearchIndex`. The builder callbacks are pure (they
 * only push into a fresh per-call stage; see `@lunora/do`'s `createRangeBuilder`
 * / `createSearchBuilder`), so the dry pass is side-effect free. `withIndex`'s
 * `range` is optional (a bare index scan) — with no callback there is no field
 * to record and nothing to reject HERE; the sibling `assertIndexDeclarationAllowed`
 * (in `wrapDatabase`, called before this one) closes that bare-scan case instead,
 * from the index's DECLARED fields rather than a recorded callback reference.
 */
const assertIndexFieldsAllowed = <Context>(
    builderCallback: ((q: unknown) => unknown) | undefined,
    columns: MaskColumns<Context>,
    tableName: string,
    method: string,
): void => {
    if (typeof builderCallback !== "function") {
        return;
    }

    const referenced = new Set<string>();

    const makeRecorder = (): unknown =>
        new Proxy(
            {},
            {
                get:
                    () =>
                    (field: unknown): unknown => {
                        if (typeof field === "string") {
                            referenced.add(field);
                        }

                        return makeRecorder();
                    },
            },
        );

    builderCallback(makeRecorder());

    for (const field of referenced) {
        if (field in columns) {
            throw new LunoraError("MASK_UNSUPPORTED", `${method}() filtering "${tableName}" by masked column "${field}" is not supported`);
        }
    }
};

/**
 * Build a writer that masks row-returning reads against the underlying
 * `MaskDatabase`. Fresh closure per request so each `MaskFn` sees the live ctx.
 */
const wrapDatabase = <Context>(
    base: MaskDatabase,
    perTable: Map<string, MaskColumns<Context>>,
    context: MaskContext<Context>,
    indexFields: IndexFieldsByTable | undefined,
): MaskDatabase => {
    // `rankBefore`/`rankPageRows` are both optional (the D1 twin omits both) —
    // captured here so `optionalWriterOverride` below can call each without
    // re-narrowing `base.<method>` inside the nested closure.
    const baseRankBefore = base.rankBefore;
    const baseRankPageRows = base.rankPageRows;

    /**
     * The per-relation-hop mask, attached to every `with`-bearing read the way
     * `rls()` attaches `relationBaseWhere`. This middleware sits ABOVE `ctx.db`,
     * so it only ever sees the rows of the table named in the call — children
     * pulled in by `with` are hydrated below it by the relation loader and would
     * come back in the clear, letting `findMany("posts", { with: { author: true } })`
     * read a masked `users.email` that a direct `users` read would have hidden
     * (and, chained, reach tables the caller can't name at all). The loader calls
     * this per hop with the hop's TARGET table, at every nesting depth it can
     * reach — see the module docblock for the one hop (cross-shard) it cannot.
     */
    const relationMask = (table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] => {
        const columns = perTable.get(table);

        return columns ? rows.map((row) => maskRow(row, columns, context)) : rows;
    };

    /**
     * Attach {@link relationMask} to a read's args.
     *
     * COMPOSES rather than overwrites: `.use(mask(A)).use(mask(B))` stacks two
     * wrappers, and the inner one's args already carry its own hook — replacing it
     * would silently drop that policy from every `with`-hydrated child while
     * top-level rows still got both, which is exactly the asymmetry that makes a
     * masking bug hard to see.
     *
     * ORDER MATTERS, and it is the reverse of what the nesting suggests. The
     * middleware chain is an onion: `.use(mask(A))` wraps `ctx.db` first, then
     * `.use(mask(B))` wraps THAT, so the handler holds B's writer. A top-level row
     * therefore comes back through A's mask and then B's — A first. But the args
     * travel the other way: B attaches its hook, then A sees it as `inner`. Running
     * `relationMask(inner(rows))` here would apply B then A, so a relation row would
     * resolve a stacked policy in the opposite order from a top-level one (an inner
     * `"redact"` under an outer `"hash"` would yield `null` on the parent and a hash
     * on the child). Applying THIS hook first and handing the result to `inner`
     * restores A-then-B on both paths.
     */
    const withRelationMask = (args?: QueryArgs): QueryArgs => {
        const inner = args?.relationMask;

        return { ...args, relationMask: inner === undefined ? relationMask : (table, rows) => inner(table, relationMask(table, rows)) };
    };

    /**
     * SECURITY (position oracle on the index DECLARATION path): `assertIndexFieldsAllowed`
     * (below) closes a range/search CALLBACK that references a masked field, but a
     * BARE `withIndex(name)` (no callback) gives its recorder nothing to observe —
     * it still returns every row ordered by the index's declared sort key. If that
     * key is a masked column, the ordinal position of every returned row leaks the
     * hidden value (one known plaintext neighbour bounds the rest). The same
     * oracle applies directly to `rank`/`rankPage`/`rankBefore`, which return the
     * row's ordinal, and to `withGeoIndex`, which returns rows sorted by distance
     * from the caller's own query point — an attacker sweeping that point/radius
     * trilaterates a masked `v.geoPoint()` column to geohash precision.
     *
     * Unlike `assertIndexFieldsAllowed`, this guards the index's DECLARED fields —
     * it needs `indexFields`, the per-table, per-KIND index→fields map an app
     * supplies via `mask(policies, { indexFields: indexFieldsFromSchema(schema) })`
     * ({@link MaskOptions.indexFields}). The caller passes its own `kind` — one of
     * `"index" | "geo" | "rank"`, the same vocabulary `@lunora/shard-engine`'s
     * `IndexUseHook` already uses — because the engine resolves `withIndex` /
     * `withGeoIndex` / rank reads in THREE SEPARATE namespaces
     * (`tableDefinition.indexes` / `.geoIndexes` / `.rankIndexes`), so the same
     * index NAME can legally denote a different index per kind. Looking up only
     * `[tableName][indexName]` on a flat map would let one kind's fields shadow
     * another's for a colliding name — checking the wrong index's fields instead
     * of the documented fail-open — which is exactly the bug this kind parameter
     * closes (plan 258). Fails OPEN (returns without throwing) for the
     * un-hardenable cases: `indexFields` wasn't supplied, or the table/kind/index
     * name isn't declared in it (an unknown index name errors downstream anyway,
     * so there is nothing left to protect by throwing here too). Only a KNOWN
     * index (of the CALLER'S kind) whose declared fields intersect the masked
     * column set throws.
     */
    const assertIndexDeclarationAllowed = (tableName: string, indexName: string, method: string, kind: "geo" | "index" | "rank"): void => {
        const columns = perTable.get(tableName);

        if (!columns) {
            return;
        }

        const declaredFields = indexFields?.[tableName]?.[kind]?.[indexName];

        if (!declaredFields) {
            return;
        }

        const offending = declaredFields.find((field) => field in columns);

        if (offending !== undefined) {
            throw new LunoraError(
                "MASK_UNSUPPORTED",
                `${method}() reading "${tableName}" via index "${indexName}" would order rows by masked column "${offending}" — use an index whose declared fields are all unmasked, or unmask the column`,
            );
        }
    };

    /**
     * Wrap a `query()` reader so every terminal read (`collect` / `first` /
     * `unique` / `take` / `paginate`) masks its rows, and every chainable
     * refinement (`filter` / `order` / `withIndex` / `withSearchIndex`) returns a
     * reader that is still masked.
     */
    const wrapReader = (reader: TableReaderLike, columns: MaskColumns<Context>, tableName: string): TableReaderLike => {
        return {
            // The spread-free literal must re-declare EVERY reader member; the
            // public `TableReader` type promises lazy iteration (`types.ts`) and
            // the raw + RLS readers deliver it — omitting it here made
            // `for await` throw only on masked tables. Rows are masked exactly
            // like every other terminal.
            // eslint-disable-next-line generator-star-spacing -- prettier owns this spacing and formats it as `async *[…]`; the rule wants `async* […]`, and prettier runs last
            async *[Symbol.asyncIterator]() {
                for await (const row of { [Symbol.asyncIterator]: () => reader[Symbol.asyncIterator]() }) {
                    yield maskRow(row, columns, context);
                }
            },
            collect: async () => {
                const rows = await reader.collect();

                return rows.map((row) => maskRow(row, columns, context));
            },
            // SECURITY (geo-distance oracle): `score` carries no column value — the
            // FTS half of this pair is already closed off upstream, because
            // `.search(field, …)` NAMES its column and `assertIndexFieldsAllowed`
            // (below, via `withSearchIndex`) throws `MASK_UNSUPPORTED` before a
            // search over a masked field ever runs, so a returned `score` can only
            // ever reflect a non-masked field. `score` therefore passes through in
            // the clear, same reasoning that lets `count`/`rank` pass through the
            // mask wrapper below.
            //
            // `distanceMeters`, in contrast, IS a value oracle: `withGeoIndex`'s
            // `.near(point, radius)` builder names no column (there is nothing for
            // `assertIndexFieldsAllowed` to guard), so a caller can run a geo query
            // against a table with a masked `v.geoPoint()` column, see the
            // `document`'s location masked to `null`, and still receive the EXACT
            // haversine distance from their probe point to the hidden coordinate.
            // Three such probes trilaterate the masked point exactly. This module
            // has no schema → geo-index-field map to prove the queried index isn't
            // built over a masked column, so — like a throwing `MaskFn` — it fails
            // closed: `distanceMeters` is withheld on every row returned by a
            // masked table's `collectWithScores()`, regardless of which column is
            // masked. This is the conservative, always-on floor for when the
            // caller hasn't supplied `MaskOptions.indexFields`; a sibling change
            // (mask index-oracle) adds a precise `withGeoIndex` declaration guard
            // that throws `MASK_UNSUPPORTED` when `indexFields` proves the geo
            // field itself is masked — once both land, the precise guard fires
            // first for provable cases and this null-out remains the fallback for
            // everything else. We don't throw here outright: this wrapper can't
            // tell whether the geo field specifically is masked vs. some unrelated
            // masked column on the same table, and throwing would break geo
            // scoring for every masked table rather than just the vulnerable ones.
            // Nulling `distanceMeters` degrades gracefully instead — the geo query
            // still runs and returns rows, only the distance is withheld.
            collectWithScores: async () => {
                const rows = await reader.collectWithScores();

                return rows.map((row): ScoredDocument => {
                    const document = maskRow(row.document, columns, context);

                    if ("distanceMeters" in row) {
                        // eslint-disable-next-line unicorn/no-null -- fail closed: withhold the geo-distance oracle, mirrors the null sentinel used elsewhere in this file
                        return { distanceMeters: null, document };
                    }

                    return { document, score: row.score };
                });
            },
            // SECURITY (value oracle): the predicate must see the MASKED row, not
            // the raw stored row — otherwise a caller can `.filter(d => d.ssn ===
            // guess)` to read the value the mask hides. Masking before the
            // predicate keeps filtering on non-masked columns working while
            // redacting masked cells the predicate can observe.
            filter: (predicate) =>
                wrapReader(
                    reader.filter((document) => predicate(maskRow(document, columns, context))),
                    columns,
                    tableName,
                ),
            first: async () => {
                const row = await reader.first();

                // eslint-disable-next-line unicorn/no-null -- mirrors the reader's `null` empty sentinel
                return row ? maskRow(row, columns, context) : null;
            },
            order: (direction) => wrapReader(reader.order(direction), columns, tableName),
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
            // SECURITY (value oracle): reject before delegating when the range /
            // search references a masked column — an index range or search term
            // over a masked column is the same value oracle as a masked-column
            // `where`, so it must fail closed (see `assertIndexFieldsAllowed`).
            // Reads over NON-masked columns pass through and still mask output.
            withIndex: (indexName, range) => {
                // Declared-fields guard FIRST: it closes the BARE scan (no `range`),
                // which the callback-recorder just below can't see — see the guard
                // function's own docblock, above `wrapDatabase`.
                assertIndexDeclarationAllowed(tableName, indexName, "withIndex", "index");
                assertIndexFieldsAllowed(range, columns, tableName, "withIndex");

                return wrapReader(reader.withIndex(indexName, range), columns, tableName);
            },
            withSearchIndex: (indexName, search) => {
                assertIndexFieldsAllowed(search, columns, tableName, "withSearchIndex");

                return wrapReader(reader.withSearchIndex(indexName, search), columns, tableName);
            },
            // A geo query's builder (`.near`/`.within`) exposes no column name, so
            // there's no masked-column VALUE oracle to guard here. But it IS a
            // POSITION oracle: `withGeoIndex(name, q => q.near(point, radius))`
            // returns rows sorted by distance from the caller's own point, and a
            // geo index has no unmasked-prefix escape the way a multi-column
            // index does — so the same `assertIndexDeclarationAllowed` guard that
            // closes the bare-`withIndex`/rank position oracle applies here too,
            // keyed off the geo index's declared field (see
            // `indexFieldsFromSchema`).
            withGeoIndex: (indexName, build) => {
                assertIndexDeclarationAllowed(tableName, indexName, "withGeoIndex", "geo");

                return wrapReader(reader.withGeoIndex(indexName, build), columns, tableName);
            },
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

        const pinnedProbe = expectedTable !== undefined && perTable.has(expectedTable) ? [expectedTable] : [];
        const probeTables = expectedTable === undefined ? [...perTable.keys()] : pinnedProbe;
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

    /**
     * Every column name masked on ANY table in this policy set.
     *
     * The scope a `where` is checked against once it leaves the root table. A
     * relation hop (`with: { author: { where: … } }`, or an `is`/`some`/… node)
     * filters the RELATION's table, and this middleware has no schema →
     * relation → target-table map to resolve which one that is. So it fails
     * closed against the union: a masked column name is refused wherever it
     * appears below the root, whichever masked table declared it.
     *
     * ponytail: over-broad by exactly the collisions — a relation `where` on an
     * unmasked table that happens to share a masked column NAME is refused too.
     * Narrow it by threading a relation→table map (like `MaskOptions.indexFields`
     * does for indexes) if a real app hits that.
     */
    const maskedAnywhere = new Set<string>();

    for (const columns of perTable.values()) {
        for (const column of Object.keys(columns)) {
            maskedAnywhere.add(column);
        }
    }

    /**
     * Walk a `where` clause and throw on the first reference to a masked column.
     *
     * `scope` is the masked-column set the CURRENT nesting level is checked
     * against — the root table's columns at the top, {@link maskedAnywhere} once
     * a relation node has been crossed. `AND`/`OR` (arrays) and `NOT` (object)
     * stay at the same level; a relation node (`{ author: { is: {…} } }`)
     * descends one. `__`-prefixed structural markers are engine internals, not
     * columns, so they're skipped.
     */
    const assertWhereScope = (where: unknown, scope: ReadonlySet<string>, label: string, method: string): void => {
        if (!where || typeof where !== "object" || Array.isArray(where)) {
            return;
        }

        for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutually recursive closure pair; neither is called until both are bound
            assertWhereEntry(key, value, scope, label, method);
        }
    };

    /** One `where` entry: a logical connector, a structural marker, a column, or a relation node. */
    const assertWhereEntry = (key: string, value: unknown, scope: ReadonlySet<string>, label: string, method: string): void => {
        if (key === "AND" || key === "OR") {
            for (const clause of Array.isArray(value) ? value : []) {
                assertWhereScope(clause, scope, label, method);
            }

            return;
        }

        if (key === "NOT") {
            assertWhereScope(value, scope, label, method);

            return;
        }

        if (key.startsWith("__")) {
            return;
        }

        // Column check FIRST: a masked column is refused whatever its value looks
        // like, so `{ ssn: { is: … } }` cannot dress a column filter up as a
        // relation node and walk past the guard.
        if (scope.has(key)) {
            throw new LunoraError("MASK_UNSUPPORTED", `${method}() filtering "${label}" by masked column "${key}" is not supported`);
        }

        // A relation node: `key` names a RELATION, not a column of this level —
        // but its bodies filter the related table, so they are checked against
        // the union scope.
        if (isRelationPredicate(value)) {
            for (const body of Object.values(value)) {
                assertWhereScope(body, maskedAnywhere, `${label}.${key}`, method);
            }
        }
    };

    /**
     * The masked-column set a ROOT-level `where`/`orderBy` on `tableName` is
     * checked against: that table's own masked columns, or nothing when the root
     * table carries no policy — an unmasked root still descends into
     * {@link maskedAnywhere} at its relation nodes.
     */
    const rootScope = (tableName: string): ReadonlySet<string> => {
        const columns = perTable.get(tableName);

        return columns ? new Set(Object.keys(columns)) : new Set<string>();
    };

    /**
     * SECURITY (value oracle): masking only redacts OUTPUT values — it does not
     * stop a caller filtering by a masked column. `findMany({ where: { ssn: { eq:
     * X } } })` (row present ⇒ value confirmed) or a range predicate lets a caller
     * binary-search the exact value the mask is meant to hide. Fail closed — like
     * `assertReductionAllowed` does for aggregate/groupBy — when a client `where`
     * references a masked column. `baseWhere` is a CALLER-reachable field on the
     * public `count`/query args (it reaches the SQL predicate via `mergeWhere`),
     * so it is routed through this same guard too — it is not a server-only field.
     *
     * The oracle is NOT confined to the root table. The engine honours a per-hop
     * `where` on a relation predicate (`{ author: { is: { ssn: … } } }`) and on a
     * `with` hop (`{ with: { author: { where: { ssn: … } } } }`) — both filter the
     * RELATED table, and a present/absent child answers the same guess a root
     * filter would while the returned column is dutifully `null`. So this runs at
     * EVERY depth, and it runs even when the root table itself is unmasked (a
     * `posts` read reaching a masked `users` used to get zero `where` checks).
     */
    const assertWhereAllowed = (tableName: string, where: unknown, method: string): void => {
        if (maskedAnywhere.size === 0 || where === undefined) {
            return;
        }

        assertWhereScope(where, rootScope(tableName), tableName, method);
    };

    /**
     * SECURITY (value oracle via sort order): masking rewrites OUTPUT cells but
     * preserves ROW ORDER, so `findMany({ orderBy: [{ ssn: "asc" }] })` returns
     * masked cells sorted by the true hidden value — a sort/binary-search/relative-
     * rank oracle across pages. Fail closed when an `orderBy` entry references a
     * masked column, mirroring `assertWhereAllowed` and the index-reader guard
     * (`order()` over a masked `withIndex` already throws). `orderBy` is a
     * `Partial<Record<column, "asc" | "desc">>[]`, so each entry's keys are the
     * ordered columns.
     *
     * `scope` is the masked-column set this level is checked against — the same
     * split `assertWhereScope` makes: {@link rootScope} at the root, and
     * {@link maskedAnywhere} for a `with` hop, whose sort is the same oracle one
     * level down over a table this middleware cannot resolve.
     */
    const assertOrderByAllowed = (label: string, orderBy: unknown, scope: ReadonlySet<string>, method: string): void => {
        if (!Array.isArray(orderBy)) {
            return;
        }

        for (const entry of orderBy) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                continue;
            }

            for (const field of Object.keys(entry as Record<string, unknown>)) {
                if (scope.has(field)) {
                    throw new LunoraError("MASK_UNSUPPORTED", `${method}() ordering "${label}" by masked column "${field}" is not supported`);
                }
            }
        }
    };

    /**
     * SECURITY (value oracle via a relation hop): the relation loader honours a
     * per-hop `where`/`orderBy` on every `with` level. With `mask({ users: { ssn }
     * })`, `posts.findMany({ with: { author: { where: { ssn: { eq: guess } } } } })`
     * returns an `author` only when the guess is right — a binary-searchable
     * oracle over the very value the mask nulls out in the response. The root
     * table (`posts`) is unmasked, so the root guards never looked.
     *
     * Walk the whole `with` tree and fail closed on a masked column in any hop's
     * `where` or `orderBy`, against {@link maskedAnywhere} (see its docblock for
     * why the hop's real target table is not resolvable here). `_count` carries
     * relation names, not a predicate, so it is skipped.
     */
    const assertWithAllowed = (label: string, withInput: unknown, method: string): void => {
        if (maskedAnywhere.size === 0 || !withInput || typeof withInput !== "object" || Array.isArray(withInput)) {
            return;
        }

        for (const [relationName, hop] of Object.entries(withInput as Record<string, unknown>)) {
            if (relationName === "_count" || !hop || typeof hop !== "object" || Array.isArray(hop)) {
                continue;
            }

            const nested = hop as { orderBy?: unknown; where?: unknown; with?: unknown };
            const hopLabel = `${label}.${relationName}`;

            assertWhereScope(nested.where, maskedAnywhere, hopLabel, method);
            assertOrderByAllowed(hopLabel, nested.orderBy, maskedAnywhere, method);
            assertWithAllowed(hopLabel, nested.with, method);
        }
    };

    /**
     * The whole caller-reachable read surface of `findMany`/`findFirst`/
     * `findFirstOrThrow`, in one place: both filters (`where` and the equally
     * caller-reachable `baseWhere`), the sort, and the `with` tree.
     *
     * The scalar readers deliberately get LESS than this, and the difference is
     * a property of their argument shapes, not an oversight:
     * `count`/`aggregate`/`groupBy` take a bare `where` (`aggregate`/`groupBy`
     * additionally route their column arguments through
     * `assertReductionAllowed`) — none of the three accepts an `orderBy` or a
     * `with`, so there is no sort oracle and no relation hop to walk. Should one
     * of them grow either argument, route it through here instead of widening
     * its own call site.
     */
    const assertReadArgsAllowed = (tableName: string, args: QueryArgs | undefined, method: string): void => {
        assertWhereAllowed(tableName, args?.where, method);
        assertWhereAllowed(tableName, args?.baseWhere, method);
        assertOrderByAllowed(tableName, args?.orderBy, rootScope(tableName), method);
        assertWithAllowed(tableName, args?.with, method);
    };

    /**
     * Narrow a `rank`/`rankBefore`/`rankPage` `options` argument (typed `unknown`
     * on `MaskDatabase` so the wrapper stays interchangeable across writers) to a
     * plain record, or `undefined` for anything else — mirrors `count`'s wrapper
     * narrowing above.
     */
    const asOptionsRecord = (value: unknown): Record<string, unknown> | undefined =>
        value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

    /**
     * SECURITY (value/presence oracle on rank reads): `rank`/`rankBefore`/
     * `rankPage` return no column value, but `where`/`baseWhere` are
     * caller-reachable on their options the same way they are on `findMany` —
     * `rank(table, index, { where: { ssn: { eq: guess } } })` is a presence
     * oracle, and combined with the returned ordinal it lets a caller binary-
     * search the hidden value's position among the masked-sorted set. Fail
     * closed exactly like `assertWhereAllowed` does for reads, before
     * delegating to `base`.
     */
    const assertRankWhereAllowed = (tableName: string, options: unknown, method: string): void => {
        const wrapper = asOptionsRecord(options);

        assertWhereAllowed(tableName, wrapper?.["where"], method);
        assertWhereAllowed(tableName, wrapper?.["baseWhere"], method);
        assertWithAllowed(tableName, wrapper?.["with"], method);
    };

    const wrapped: MaskDatabase = {
        ...base,

        async deleteWhere(tableName, where, options) {
            assertWhereAllowed(tableName, where, "deleteMany({ where })");

            if (base.deleteWhere === undefined) {
                throw new LunoraError("INTERNAL", `ctx.db.${tableName}.deleteMany({ where }) is unavailable: this writer has no where-based delete`);
            }

            return base.deleteWhere(tableName, where, options);
        },

        async patchWhere(tableName, args, options) {
            assertWhereAllowed(tableName, args.where, "patchMany({ where })");

            if (base.patchWhere === undefined) {
                throw new LunoraError("INTERNAL", `ctx.db.${tableName}.patchMany({ where }) is unavailable: this writer has no where-based patch`);
            }

            return base.patchWhere(tableName, args, options);
        },

        aggregate(tableName, options) {
            assertReductionAllowed(tableName, [options.field], "aggregate");
            assertWhereAllowed(tableName, options.where, "aggregate");

            return base.aggregate(tableName, options);
        },

        count(tableName, whereOrArgs) {
            // A masked-column `where` is an existence/value oracle even through a
            // row-count (no value returned but presence leaks). `count(where)` may
            // pass a bare `where` or an args wrapper — unwrap the client `where`.
            const wrapper = asOptionsRecord(whereOrArgs);
            const where = wrapper && ("where" in wrapper || "baseWhere" in wrapper || "restrictsCounts" in wrapper) ? wrapper.where : whereOrArgs;

            assertWhereAllowed(tableName, where, "count");

            // `baseWhere` is in the public `count` args and reaches the SQL
            // predicate (`mergeWhere(baseWhere, where, scope)`), so a masked
            // column smuggled through it is the same oracle — guard it too.
            if (wrapper) {
                assertWhereAllowed(tableName, wrapper.baseWhere, "count");
            }

            return base.count(tableName, whereOrArgs);
        },

        async findFirst(tableName, args) {
            assertReadArgsAllowed(tableName, args, "findFirst");

            const row = await base.findFirst(tableName, withRelationMask(args));
            const columns = perTable.get(tableName);

            return row && columns ? maskRow(row, columns, context) : row;
        },

        async findFirstOrThrow(tableName, args) {
            assertReadArgsAllowed(tableName, args, "findFirstOrThrow");

            const row = await base.findFirstOrThrow(tableName, withRelationMask(args));
            const columns = perTable.get(tableName);

            return columns ? maskRow(row, columns, context) : row;
        },

        async findMany(tableName, args) {
            assertReadArgsAllowed(tableName, args, "findMany");

            const page = await base.findMany(tableName, withRelationMask(args));
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

        // Delegates to `base.lookupById` directly, not `locate` above (which
        // folds the table name away) — the `...base` spread would otherwise expose it unmasked.
        async lookupById(id, expectedTable) {
            const located = await base.lookupById?.(id, expectedTable);

            if (!located) {
                // eslint-disable-next-line unicorn/no-null -- mirrors the seam's own `null`-for-absent contract
                return null;
            }

            const columns = perTable.get(located.tableName);

            return { row: columns ? maskRow(located.row, columns, context) : located.row, tableName: located.tableName };
        },

        groupBy(tableName, options) {
            assertReductionAllowed(tableName, [...options.by, options.agg?.field], "groupBy");
            assertWhereAllowed(tableName, options.where, "groupBy");

            return base.groupBy(tableName, options);
        },

        query(tableName) {
            const reader = base.query(tableName);
            const columns = perTable.get(tableName);

            return columns ? wrapReader(reader, columns, tableName) : reader;
        },

        async rank(tableName, indexName, options) {
            assertRankWhereAllowed(tableName, options, "rank");
            assertIndexDeclarationAllowed(tableName, indexName, "rank", "rank");

            return base.rank(tableName, indexName, options);
        },

        async rankPage(tableName, indexName, options) {
            assertRankWhereAllowed(tableName, options, "rankPage");
            assertIndexDeclarationAllowed(tableName, indexName, "rankPage", "rank");

            const page = await base.rankPage(tableName, indexName, options);
            const columns = perTable.get(tableName);

            return columns ? maskPage(page, columns, context) : page;
        },

        // `rankBefore`/`rankPageRows` are the two optional methods (the D1 twin omits both) — see `optionalWriterOverride`.
        ...optionalWriterOverride("rankBefore", baseRankBefore, (rankBefore) => (tableName: string, indexName: string, options: unknown) => {
            assertRankWhereAllowed(tableName, options, "rankBefore");
            assertIndexDeclarationAllowed(tableName, indexName, "rankBefore", "rank");

            return rankBefore(tableName, indexName, options);
        }),
        ...optionalWriterOverride("rankPageRows", baseRankPageRows, (rankPageRows) => async (tableName: string, indexName: string, options: unknown) => {
            assertRankWhereAllowed(tableName, options, "rankPageRows");
            assertIndexDeclarationAllowed(tableName, indexName, "rankPageRows", "rank");

            const result = await rankPageRows(tableName, indexName, options);
            const columns = perTable.get(tableName);

            return columns
                ? {
                      ...result,
                      rows: result.rows.map((row) => {
                          return { ...row, doc: maskRow(row.doc, columns, context) };
                      }),
                  }
                : result;
        }),
    };

    // SECURITY: the generated runtime glues a per-table facade
    // (`ctx.db.users.findMany(...)`) onto `ctx.db`, bound to the UNWRAPPED
    // writer. The `...base` spread copies those raw-bound accessors verbatim, so
    // without this loop a table's facade would read around the mask. Re-bind
    // through the wrapped writer using the SAME `bindTableFacade` codegen emits,
    // so the two can't drift.
    //
    // EVERY facade entry is re-bound, not just the masked tables'. A read of an
    // UNMASKED root reaches a masked column two ways — a `with` hop or a
    // relation predicate hydrates the masked child (`relationMask` is what
    // redacts it), and a per-hop `where`/`orderBy` on that child is the value
    // oracle `assertWithAllowed` closes. Both live on the wrapper, so
    // `ctx.db.posts.findMany({ with: { author: … } })` under
    // `mask({ users: { ssn } })` served the child's `ssn` in the clear while
    // `ctx.db.findMany("posts", …)` refused it. Which unmasked tables can reach
    // a masked one is exactly the relation→table map this middleware does not
    // have (see `maskedAnywhere`), so the condition is the same fail-closed one
    // every guard uses: any mask at all ⇒ re-bind everything. Codegen binds all
    // facade entries — `.global()` D1 tables included — through the one shard
    // ctx-db, so re-binding cannot send a read to the wrong backend.
    const writableFacade = wrapped as unknown as Record<string, unknown>;

    if (maskedAnywhere.size > 0) {
        for (const [tableName, entry] of Object.entries(base as unknown as Record<string, unknown>)) {
            if (isFacadeEntry(entry)) {
                writableFacade[tableName] = bindTableFacade(wrapped, tableName);
            }
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

    const middleware: Middleware<Context, Context> = async ({ ctx, next }) => {
        const maskContext: MaskContext<Context> = { auth: await resolvePolicyAuth(ctx.auth ?? {}, rolePermissions), ctx };

        // Procedure-wide escape hatch: a privileged caller sees raw values, so
        // we forward the unwrapped ctx untouched (no wrap, no facade rebind).
        //
        // SECURITY: narrowed to the exact `true`, like every sibling gate
        // (`rls`'s `decision === true`, `storageRules`' `rule.when(...) === true`,
        // `http-storage`'s serve authorizer, the runtime's `grants`). `bypass` is
        // DECLARED to answer a boolean but it is app code, and the canonical
        // mistake — `bypass: ({ auth }) => auth.identity?.role`, the `.can(...)` or
        // `=== "admin"` forgotten — hands back a TRUTHY string. Evaluated by
        // truthiness that skipped the whole mask for every caller whose claim was
        // merely present, serving `ssn` / `email` / `hashedPassword` raw with no
        // error and nothing in the logs. This is the one direction that must fail
        // closed: a weird value now masks rather than unmasks.
        if (options.bypass?.(maskContext) === true) {
            return next();
        }

        const wrapped = wrapDatabase<Context>(ctx.db, perTable, maskContext, options.indexFields);
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

    // Surface the masked table→column NAMES on the middleware so the
    // procedure builder can hoist them onto the registered function
    // (`fn.maskedTables`) — see `policy-tag.ts` for why nothing downstream of
    // this tag ever sees the strategies/closures, and why the shape/mask
    // fail-closed check (plan 208) reads codegen's static discovery instead
    // of this tag at runtime.
    const columns = new Map<string, ReadonlySet<string>>();

    for (const [table, strategies] of perTable) {
        columns.set(table, new Set(Object.keys(strategies)));
    }

    return tagMaskMiddleware(middleware, { columns });
};

export { mask };
export type { MaskDatabase };
