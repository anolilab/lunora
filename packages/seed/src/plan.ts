import { LunoraError } from "@lunora/errors";
import type { Schema } from "@lunora/server";

import { copycat, setHashKey } from "./copycat";
import { generateValue } from "./generate-value";
import type { FieldSpec } from "./introspect";
import { fkParentClosure, introspectSchema, orderTables } from "./introspect";

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
 * The canonical copycat hash input for one cell: a stable tuple per
 * `(seed, table, row index, column)`. Both the primary key and every column
 * value derive from this same shape so the two can never silently drift.
 * `seed` is included for self-documentation; variance across seeds also comes
 * from the global hash salt {@link setHashKey} sets.
 */
const cellInput = (seed: number, table: string, index: number, column: string): ReadonlyArray<unknown> => [seed, table, index, column];

/** Generate a single column value, resolving foreign keys against seeded and pre-existing parents. */
const generateField = (
    field: FieldSpec,
    table: string,
    input: ReadonlyArray<unknown>,
    localIndex: number,
    idsByTable: ReadonlyMap<string, ReadonlyArray<string>>,
    existingIds: Readonly<Record<string, ReadonlyArray<string>>>,
    now: number,
): unknown => {
    if (field.fkTable !== undefined) {
        const pool = fkPool(field, table, localIndex, idsByTable, existingIds);

        if (pool.length === 0) {
            // No parent to point at. Omit when the column tolerates it; otherwise
            // fall back to a placeholder id so the row stays insertable.
            return fkFallback(field, input);
        }

        return copycat.oneOf(input, pool);
    }

    // Columns the server fills (.default()/.$defaultFn()) are left out so the
    // server's own default applies.
    if (field.hasServerDefault) {
        return undefined;
    }

    return generateValue(field.validator, field.name, input, now);
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
                apply(field.name, () => generateField(field, table, cellInput(seed, table, index, field.name), localIndex, idsByTable, existingIds, now));
            }

            rows.push(row);
        }

        plan.push({ rows, table });
    }

    return plan;
};

export { seedPlan };
export type { OverrideContext, SeedCounts, SeedOptions, SeedOverrides, TablePlan };
