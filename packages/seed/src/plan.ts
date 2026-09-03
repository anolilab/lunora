import { LunoraError } from "@lunora/errors";
import type { Schema } from "@lunora/server";

import { copycat, setHashKey } from "./copycat";
import { generateValue } from "./generate-value";
import type { FieldSpec } from "./introspect";
import { fkParentClosure, introspectSchema, orderTables } from "./introspect";
import type { UniqueDeal } from "./unique-value";
import { planUniqueDeal, planUniqueFkDeal } from "./unique-value";

/**
 * The pure, I/O-free core of seeding. {@link seedPlan} introspects a schema,
 * generates rows table-by-table in foreign-key order, and resolves every
 * `v.id("parent")` column to a real id of an already-generated parent row. The
 * result feeds every adapter (test harness, CLI, studio) — none of them
 * re-implement generation.
 *
 * Determinism: a `seed` value selects the global copycat mapping, and each value
 * is hashed from `[seed, table, index, field]`, so the same `(schema, options)`
 * always yields byte-identical rows.
 */

/** A row context handed to an override function. */
interface OverrideContext {
    field: string;
    /** The row's absolute index (the `indexOffset` base plus its position in this batch). */
    index: number;
    /** The row built so far (system `_id` first, then earlier fields). */
    row: Record<string, unknown>;

    /**
     * A live, read-only view of every table's rows generated so far this run,
     * keyed by table name. Lets an override correlate across tables (e.g. copy a
     * field from the parent row a foreign key points at). Rows for the current
     * table accumulate as they are built, so only earlier rows are visible.
     */
    store: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
    table: string;
}

/**
 * Per-table, per-field overrides. Each override is a static value or a function
 * of the row context; field `_id` overrides the generated primary key.
 */
type SeedOverrides = Record<string, Record<string, unknown>>;

/** Per-table row counts. */
type SeedCounts = Record<string, number>;

interface SeedOptions {
    /** Rows per table; falls back to {@link SeedOptions.defaultCount} when a table is absent. */
    counts?: SeedCounts;
    /** Count used for any selected table not present in `counts` (default `10`). */
    defaultCount?: number;

    /**
     * Ids of rows that already exist in the target store, keyed by table. Foreign
     * keys may resolve to these in addition to freshly-seeded parents, and a
     * parent table fully covered here is not re-seeded when it is only pulled in
     * as an FK dependency (it is when named explicitly in `only`).
     */
    existingIds?: Readonly<Record<string, ReadonlyArray<string>>>;

    /**
     * Per-table absolute index base for generation. Defaults to `0`. A client
     * seeding the same table across several calls passes the running total so
     * each batch hashes from fresh indices and never collides ids with an
     * earlier batch.
     */
    indexOffset?: Readonly<Record<string, number>>;

    /**
     * Wall-clock reference for time-valued columns (`createdAt`, `expiresAt`, …),
     * as epoch-ms. Defaults to now.
     *
     * Pin it to make a plan byte-for-byte reproducible: seeding is deterministic
     * in `seed` alone for every other column, and this is the one input that
     * would otherwise drift between runs. A pinned `(seed, now)` pair is what
     * makes a seeded screenshot, test fixture, or bug report replayable.
     */
    now?: number;

    /**
     * Restrict seeding to these tables. Transitive `v.id(...)` parents are added
     * automatically (unless already covered by `existingIds`) so child foreign
     * keys resolve to real rows. The result is still ordered by FK dependency.
     * Default: all tables.
     */
    only?: ReadonlyArray<string>;
    /** Static values or functions overriding generated columns. */
    overrides?: SeedOverrides;
    /** Deterministic mapping selector — same seed ⇒ same rows. Default `0`. */
    seed?: number;
}

/** One table's generated rows, in insert order. Each row carries an explicit `_id`. */
interface TablePlan {
    rows: ReadonlyArray<Record<string, unknown>>;
    table: string;
}

const resolveOverride = (override: unknown, context: OverrideContext): unknown =>
    typeof override === "function" ? (override as (context: OverrideContext) => unknown)(context) : override;

/** Resolve the value a foreign-key column takes when no seeded parent exists. */
const fkFallback = (field: FieldSpec, input: unknown): unknown => {
    if (field.optional) {
        return undefined;
    }

    // eslint-disable-next-line unicorn/no-null -- null is the SQL value a nullable FK takes when no parent exists
    return field.nullable ? null : copycat.uuid(input);
};

/** The foreign-key pool a column may resolve against: freshly-seeded ids plus pre-existing ones. */
const fkPool = (
    field: FieldSpec,
    table: string,
    localIndex: number,
    idsByTable: ReadonlyMap<string, ReadonlyArray<string>>,
    existingIds: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<string> => {
    const fkTable = field.fkTable as string;
    // Self-reference: draw only from rows generated earlier in this run's table
    // (`localIndex` is the position within this call, independent of any offset).
    const seeded = fkTable === table ? (idsByTable.get(table) ?? []).slice(0, localIndex) : (idsByTable.get(fkTable) ?? []);
    const existing = existingIds[fkTable] ?? [];

    return existing.length === 0 ? seeded : [...seeded, ...existing];
};

/**
 * The parent a SELF-referencing `.unique()` foreign key points at.
 *
 * Its pool is not known at plan time (it is the rows this very batch has yet to
 * generate), so it carries no {@link UniqueDeal} and the choice is made here —
 * and it has to be distinct for every row by construction, since a UNIQUE index
 * covers the column.
 *
 * Candidates are ordered `[...alreadyInTheStore, ...earlierRowsOfThisBatch]`
 * and row `localIndex` takes the entry at that position: the list has grown to
 * exactly `existing.length + localIndex` entries by the time the row needs one,
 * so the position is in range whenever the table already holds a row, and every
 * row lands on a different candidate. Taking the pool's LAST entry instead —
 * which is what `fkPool` appends `existingIds` to the end for — handed EVERY row
 * the same pre-existing id and violated the constraint on the second row.
 *
 * With nothing pre-existing the list is just this batch's earlier rows and the
 * position runs off its end; the last of them (the immediately preceding row) is
 * then the one choice distinct for every row. Row 0 of an empty table has no
 * candidate at all and never reaches here — `generateField` has already taken
 * the empty-pool branch.
 */
const selfReferenceParent = (
    table: string,
    localIndex: number,
    idsByTable: ReadonlyMap<string, ReadonlyArray<string>>,
    existingIds: Readonly<Record<string, ReadonlyArray<string>>>,
): string | undefined => {
    const candidates = [...(existingIds[table] ?? []), ...(idsByTable.get(table) ?? []).slice(0, localIndex)];

    return candidates[localIndex] ?? candidates.at(-1);
};

/**
 * The canonical copycat hash input for one cell: a stable tuple per
 * `(seed, table, row index, column)`. Both the primary key and every column
 * value derive from this same shape so the two can never silently drift.
 * `seed` is included for self-documentation; variance across seeds also comes
 * from the global hash salt {@link setHashKey} sets.
 */
const cellInput = (seed: number, table: string, index: number, column: string): ReadonlyArray<unknown> => [seed, table, index, column];

/** Everything one cell's generation depends on beyond the column itself. */
interface RowContext {
    /** Ids that already exist in the target store, keyed by table. */
    existingIds: Readonly<Record<string, ReadonlyArray<string>>>;
    /** Ids generated so far this run, keyed by table. */
    idsByTable: ReadonlyMap<string, ReadonlyArray<string>>;
    /** The row's ABSOLUTE index — the `indexOffset` base plus its position in this batch. */
    index: number;
    /** The copycat hash seed for this cell (see {@link cellInput}). */
    input: ReadonlyArray<unknown>;
    /** The row's position WITHIN this call, independent of any offset. */
    localIndex: number;
    /** Wall-clock reference for time-valued columns. */
    now: number;
    table: string;
    /** How each `.unique()` column deals its values, keyed by column name (see {@link planUniqueDeals}). */
    uniqueDeals: ReadonlyMap<string, UniqueDeal>;
}

/** Generate a single column value, resolving foreign keys against seeded and pre-existing parents. */
const generateField = (field: FieldSpec, context: RowContext): unknown => {
    const { existingIds, idsByTable, index, input, localIndex, now, table, uniqueDeals } = context;

    if (field.fkTable !== undefined) {
        const pool = fkPool(field, table, localIndex, idsByTable, existingIds);

        if (pool.length === 0) {
            // No parent to point at. Omit when the column tolerates it; otherwise
            // fall back to a placeholder id so the row stays insertable.
            return fkFallback(field, input);
        }

        if (!field.unique) {
            return copycat.oneOf(input, pool);
        }

        const fkDeal = uniqueDeals.get(field.name);

        // A self-reference's pool is not known at plan time, so it carries no
        // deal (see `planUniqueDeals`) and `selfReferenceParent` picks the one
        // candidate that is distinct for every row.
        return fkDeal === undefined ? selfReferenceParent(table, localIndex, idsByTable, existingIds) : fkDeal.valueAt(index, () => copycat.oneOf(input, pool));
    }

    // Columns the server fills (.default()/.$defaultFn()) are left out so the
    // server's own default applies.
    if (field.hasServerDefault) {
        return undefined;
    }

    const deal = field.unique ? uniqueDeals.get(field.name) : undefined;

    if (deal !== undefined) {
        // Derived from the ABSOLUTE index, and `planUniqueDeals` has already
        // proven the deal's capacity covers every index this batch reaches.
        return deal.valueAt(index, () => generateValue(field.validator, field.name, input, now));
    }

    return generateValue(field.validator, field.name, input, now);
};

/**
 * Decide how every `.unique()` column of one table deals its values, and fail
 * fast when a column cannot produce as many distinct values as the batch asks
 * for — otherwise the collision only surfaces later as a raw UNIQUE-constraint
 * error with no attribution to the column.
 *
 * Capacity is checked against `offset + count`, NOT `count`: values are dealt by
 * ABSOLUTE row index, and `indexOffset` exists precisely so one table can be
 * seeded across several calls. Checking the batch size alone would let two
 * batches of 2 over a 3-value domain pass and then collide (index 3 wraps onto
 * index 0), which is the exact scenario the offset feature enables.
 *
 * Server-defaulted columns are skipped (their values never reach the generator)
 * — but a FOREIGN KEY does reach it, default or not, since `generateField`
 * resolves the FK before it consults the default. A foreign key is dealt from
 * its parent pool, whose size is the capacity; a SELF-referencing one is
 * skipped because its pool is the rows this very batch has yet to generate, and
 * `generateField` deals it the preceding row instead.
 *
 * An overridden column still gets a deal — an override may resolve to
 * `undefined` and defer back to the generator — but its capacity is not
 * asserted, since the caller supplying the values decides their uniqueness.
 */
const planUniqueDeals = (
    fields: ReadonlyArray<FieldSpec>,
    table: string,
    count: number,
    offset: number,
    now: number,
    tableOverrides: Record<string, unknown>,
    poolOf: (field: FieldSpec) => ReadonlyArray<string>,
): ReadonlyMap<string, UniqueDeal> => {
    const deals = new Map<string, UniqueDeal>();

    for (const field of fields) {
        if (!field.unique || (field.hasServerDefault && field.fkTable === undefined) || field.fkTable === table) {
            continue;
        }

        const pool = field.fkTable === undefined ? undefined : poolOf(field);

        // An FK with no parent to point at never reaches the pool: every row
        // takes `fkFallback`, which is a fresh uuid (distinct), or an absent /
        // null cell (which no UNIQUE constraint counts). Nothing to deal, and
        // nothing to refuse.
        if (pool?.length === 0) {
            continue;
        }

        const deal = pool === undefined ? planUniqueDeal(field, { now, table }) : planUniqueFkDeal(pool, table, field.name);
        const required = offset + count;

        if (required > deal.capacity && !Object.hasOwn(tableOverrides, field.name)) {
            throw new LunoraError(
                "BAD_REQUEST",
                `cannot seed ${String(required)} rows into "${table}": unique column "${field.name}" has only ${String(deal.capacity)} possible values`,
            );
        }

        deals.set(field.name, deal);
    }

    return deals;
};

/**
 * Build a deterministic, FK-consistent set of rows for `schema`.
 * @returns one {@link TablePlan} per seeded table, ordered so a table's FK
 * parents come before it.
 */
const seedPlan = (schema: Schema, options: SeedOptions = {}): ReadonlyArray<TablePlan> => {
    const { counts = {}, defaultCount = 10, existingIds = {}, indexOffset = {}, now = Date.now(), only, overrides = {}, seed = 0 } = options;

    setHashKey(seed);

    const specs = introspectSchema(schema);

    // Surface an explicit error for a typo'd table rather than silently seeding
    // nothing. The CLI guards `--table` upstream, but the testing adapter and any
    // direct `seedPlan` caller would otherwise get a confusing empty plan.
    if (only !== undefined) {
        const known = new Set(specs.map((spec) => spec.name));

        for (const name of only) {
            if (!known.has(name)) {
                const available = specs.map((spec) => spec.name).join(", ");

                throw new LunoraError("BAD_REQUEST", `unknown table "${name}" in seed \`only\` — schema defines: ${available || "(no tables)"}`);
            }
        }
    }

    const requested = new Set(only ?? specs.map((spec) => spec.name));
    // Parents fully covered by `existingIds` (and not requested outright) are not
    // seeded, so the FK closure must also stop traversing *through* them — pulling
    // in a covered parent's own parents would seed grandparent tables nobody
    // requested and nothing references. A table counts as covered only when it
    // supplies at least one id; an empty array means the caller sampled the table
    // but found no rows, so its FKs still need a freshly-seeded pool.
    const covered = new Set(Object.keys(existingIds).filter((table) => !requested.has(table) && (existingIds[table] ?? []).length > 0));
    const selected = new Set(
        [...fkParentClosure(specs, requested, covered)].filter((table) => requested.has(table) || (existingIds[table] ?? []).length === 0),
    );
    const order = orderTables(specs, selected);
    const specByName = new Map(specs.map((spec) => [spec.name, spec]));

    // Accumulates the ids generated per table so child FKs can reference them.
    const idsByTable = new Map<string, string[]>();
    // A live view of generated rows handed to override functions as `store`.
    const storeRows: Record<string, Record<string, unknown>[]> = {};
    const plan: TablePlan[] = [];

    for (const table of order) {
        const spec = specByName.get(table);

        if (spec === undefined) {
            continue;
        }

        const tableOverrides = overrides[table] ?? {};
        const count = counts[table] ?? defaultCount;
        // Absolute index base — lets a client seed the same table across calls
        // without colliding ids (each id/value hashes from the absolute index).
        const offset = indexOffset[table] ?? 0;
        // A parent table is fully generated before its children (`orderTables`),
        // so a non-self FK's pool is already final here — `localIndex` only
        // matters for the self-reference `planUniqueDeals` skips.
        const uniqueDeals = planUniqueDeals(spec.fields, table, count, offset, now, tableOverrides, (field) =>
            fkPool(field, table, 0, idsByTable, existingIds),
        );

        const ids: string[] = [];
        idsByTable.set(table, ids);
        const rows: Record<string, unknown>[] = [];
        storeRows[table] = rows;

        for (let localIndex = 0; localIndex < count; localIndex += 1) {
            const index = offset + localIndex;
            const row: Record<string, unknown> = {};
            const apply = (field: string, fallback: () => unknown): void => {
                if (Object.hasOwn(tableOverrides, field)) {
                    const overridden = resolveOverride(tableOverrides[field], { field, index, row, store: storeRows, table });

                    // An override resolving to `undefined` defers to the generator,
                    // so sparse rows (a partial that omits this field) still get a
                    // generated value rather than an explicit `undefined`.
                    if (overridden !== undefined) {
                        row[field] = overridden;

                        return;
                    }
                }

                const value = fallback();

                if (value !== undefined) {
                    row[field] = value;
                }
            };

            // Explicit primary key, so children can reference it.
            apply("_id", () => copycat.uuid(cellInput(seed, table, index, "_id")));
            ids.push(row._id as string);

            for (const field of spec.fields) {
                apply(field.name, () =>
                    generateField(field, {
                        existingIds,
                        idsByTable,
                        index,
                        input: cellInput(seed, table, index, field.name),
                        localIndex,
                        now,
                        table,
                        uniqueDeals,
                    }),
                );
            }

            rows.push(row);
        }

        plan.push({ rows, table });
    }

    return plan;
};

export { seedPlan };
export type { OverrideContext, SeedCounts, SeedOptions, SeedOverrides, TablePlan };
