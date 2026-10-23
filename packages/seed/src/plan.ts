import { LunoraError } from "@lunora/errors";
import type { Schema } from "@lunora/server";

import { copycat, setHashKey } from "./copycat";
import { generateValue } from "./generate-value";
import type { FieldSpec, TableSpec, UniqueIndexSpec } from "./introspect";
import { fkParentClosure, introspectSchema, orderTables } from "./introspect";
import type { UniqueDeal } from "./unique-value";
import { planCompositeMemberDeal, planUniqueDeal, planUniqueFkDeal } from "./unique-value";

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
    /**
     * Let a REQUIRED foreign key with no parent to point at take a fresh, dangling
     * uuid instead of refusing. Off by default: a dangling id fails every join and
     * `ctx.db.get` on the row, so it should be a deliberate choice.
     */
    allowOrphans?: boolean;
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

/** Marks a foreign-key cell whose parent table is generated later (a cycle); filled by the second pass. */
const DEFERRED = Symbol("deferred foreign key");

/**
 * Resolve the value a foreign-key column takes when no parent exists to point at.
 *
 * A required column has no honest value then, so it is refused with the column
 * named — unless the caller opted into orphans with `allowOrphans`, which takes a
 * fresh uuid.
 */
const fkFallback = (field: FieldSpec, table: string, input: unknown, allowOrphans: boolean): unknown => {
    if (field.optional) {
        return undefined;
    }

    if (field.nullable) {
        // eslint-disable-next-line unicorn/no-null -- null is the SQL value a nullable FK takes when no parent exists
        return null;
    }

    if (allowOrphans) {
        return copycat.uuid(input);
    }

    throw new LunoraError(
        "BAD_REQUEST",
        `cannot seed "${table}": required foreign key "${field.name}" points at "${field.fkTable as string}", which has no rows to reference. Seed "${field.fkTable as string}" too, make "${field.name}" optional or nullable, supply "${field.name}" yourself, or pass \`allowOrphans: true\` (\`--allow-orphans\` on the CLI) to accept dangling ids.`,
    );
};

/**
 * The foreign-key pool a column may resolve against — freshly-seeded ids plus
 * pre-existing ones — as a function of the row's position in this call.
 *
 * Built ONCE per (table, column) before the row loop. A non-self FK's parent is
 * either fully generated by then, so its pool is one fixed array, or — on a cycle
 * edge — selected but scheduled later, so the pool is empty and every cell is
 * deferred to the second pass. Pre-existing parent ids are held back too in that
 * case: a pool of only those would let a `.unique()` column be planned (and
 * refused) against fewer ids than the parent ends up with. A self-reference
 * draws only from rows generated earlier in this table (`localIndex` is the
 * position within this call, independent of any offset): its array grows by one
 * seeded id per row, inserted ahead of the pre-existing ids, so the order — and
 * therefore every `copycat.oneOf` draw — matches `[...earlierRows, ...existing]`.
 */
const fkPoolFor = (
    field: FieldSpec,
    table: string,
    idsByTable: ReadonlyMap<string, ReadonlyArray<string>>,
    existingIds: Readonly<Record<string, ReadonlyArray<string>>>,
    selected: ReadonlySet<string>,
): ((localIndex: number) => ReadonlyArray<string>) => {
    const fkTable = field.fkTable as string;
    const existing = existingIds[fkTable] ?? [];

    if (fkTable !== table && selected.has(fkTable) && !idsByTable.has(fkTable)) {
        return () => [];
    }

    if (fkTable !== table) {
        const pool = [...(idsByTable.get(fkTable) ?? []), ...existing];

        return () => pool;
    }

    const own = idsByTable.get(table) ?? [];
    const pool = [...existing];
    let included = 0;

    return (localIndex) => {
        for (; included < localIndex; included += 1) {
            pool.splice(included, 0, own[included] as string);
        }

        return pool;
    };
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
    const existing = existingIds[table] ?? [];
    const own = idsByTable.get(table) ?? [];

    // The candidate list `[...existing, ...own.slice(0, localIndex)]` read by position, without building it.
    if (localIndex < existing.length) {
        return existing[localIndex];
    }

    const ownPosition = localIndex - existing.length;

    // With rows already stored the position is always inside this batch's earlier rows; with none it runs off the end.
    return ownPosition < localIndex ? own[ownPosition] : (own[localIndex - 1] ?? existing.at(-1));
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
    /** Whether a required foreign key may take a dangling id when its pool is empty. */
    allowOrphans: boolean;
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
    /** Each foreign-key column's pool, built once per table (see {@link fkPoolFor}). */
    pools: ReadonlyMap<string, (localIndex: number) => ReadonlyArray<string>>;
    /** The tables this run seeds, so a parent generated later (a cycle) can be told from one that is simply absent. */
    selected: ReadonlySet<string>;
    table: string;
    /** How each `.unique()` column deals its values, keyed by column name (see {@link planUniqueDeals}). */
    uniqueDeals: ReadonlyMap<string, UniqueDeal>;
}

/**
 * The value for a foreign key whose pool is empty. A parent generated LATER in
 * this run (a table cycle) leaves the cell for the second pass; otherwise there
 * is no parent at all, so the column is omitted, nulled, refused or — with
 * `allowOrphans` — given a placeholder id.
 */
const emptyPoolValue = (field: FieldSpec, context: RowContext): unknown => {
    const { allowOrphans, idsByTable, input, selected, table } = context;
    const parent = field.fkTable as string;

    if (parent === table || !selected.has(parent) || idsByTable.has(parent)) {
        return fkFallback(field, table, input, allowOrphans);
    }

    return DEFERRED;
};

/** Generate a single column value, resolving foreign keys against seeded and pre-existing parents. */
const generateField = (field: FieldSpec, context: RowContext): unknown => {
    const { existingIds, idsByTable, index, input, localIndex, now, pools, table, uniqueDeals } = context;

    if (field.fkTable !== undefined) {
        const pool = (pools.get(field.name) as (localIndex: number) => ReadonlyArray<string>)(localIndex);

        if (pool.length === 0) {
            return emptyPoolValue(field, context);
        }

        const fkDeal = uniqueDeals.get(field.name);

        if (!field.unique && fkDeal === undefined) {
            return copycat.oneOf(input, pool);
        }

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

    const deal = uniqueDeals.get(field.name);

    if (deal !== undefined) {
        // Derived from the ABSOLUTE index, and `planUniqueDeals` has already
        // proven the deal's capacity covers every index this batch reaches.
        return deal.valueAt(index, () => generateValue(field.validator, field.name, input, now));
    }

    return generateValue(field.validator, field.name, input, now);
};

/**
 * Refuse a `.unique()` SELF-referencing foreign key into a table that already
 * holds rows.
 *
 * A self-reference is dealt the preceding row rather than from a pool, which is
 * distinct within one batch and says nothing across calls: `existingIds` carries
 * the table's row IDS, never the values those rows already store IN this column,
 * so nothing here can tell which parents are taken — and `indexOffset` only keeps
 * `_id` from repeating. Inserting anyway violates the constraint the deal exists
 * to satisfy, so it is refused with the column named, as the pool-capacity check
 * already does.
 *
 * An override is the escape hatch: the caller then owns the values, and the
 * planner does not need to know what is stored.
 * @param field The self-referencing field.
 * @param table The table being seeded.
 * @param poolOf The parent pool resolver — for a self-reference this is the
 * table's pre-existing ids, since its own batch has generated none yet.
 * @param tableOverrides Caller-supplied column values for this table.
 */
const assertSelfReferenceDealable = (
    field: FieldSpec,
    table: string,
    poolOf: (field: FieldSpec) => ReadonlyArray<string>,
    tableOverrides: Record<string, unknown>,
): void => {
    if (poolOf(field).length === 0 || Object.hasOwn(tableOverrides, field.name)) {
        return;
    }

    throw new LunoraError(
        "BAD_REQUEST",
        `cannot seed into the non-empty table "${table}": unique self-referencing column "${field.name}" cannot be dealt across calls, because the values already stored in it are not knowable from the row ids. Seed the table in one call, or supply "${field.name}" yourself.`,
    );
};

/** A composite-index member chosen to carry part of the index's distinctness. */
interface Carrier {
    deal: UniqueDeal;
    field: FieldSpec;
}

/**
 * Give each carrier of a composite index its own digit of the row's index.
 *
 * The raw digits are the mixed-radix split of the index (the first carrier
 * varies fastest), and each carrier then shifts its raw digit by the sum of the
 * earlier carriers' raw digits, modulo its capacity. The shift depends only on
 * earlier digits, so the split stays invertible and indexes below the product
 * still give distinct tuples, but every carrier changes from one row to the next:
 * with plain mixed radix the later carriers held one value for a whole cycle of
 * the earlier ones, which put every link of a through table on one parent.
 */
const assignDigits = (carriers: ReadonlyArray<Carrier>, capacity: number, deals: Map<string, UniqueDeal>): void => {
    const strides: number[] = [];
    let stride = 1;

    for (const { deal } of carriers) {
        strides.push(stride);
        stride *= deal.capacity;
    }

    const rawDigit = (valueIndex: number, position: number): number =>
        Math.floor(valueIndex / (strides[position] as number)) % (carriers[position] as Carrier).deal.capacity;

    for (const [position, { deal, field }] of carriers.entries()) {
        deals.set(field.name, {
            capacity,
            valueAt: (valueIndex, generate) => {
                let shift = 0;

                for (let earlier = 0; earlier < position; earlier += 1) {
                    shift += rawDigit(valueIndex, earlier);
                }

                return deal.valueAt((rawDigit(valueIndex, position) + shift) % deal.capacity, generate);
            },
        });
    }
};

/**
 * Deal one multi-column `unique` index so each row takes a distinct combination
 * of its members.
 *
 * Distinctness has to come from members whose number of distinct values is
 * known, so only those can carry it: foreign keys (their parent pool), then
 * closed domains (enum, boolean, literal union, bounded number, bytes), then
 * members whose dealt value rewrites the generated one (an index-tagged string,
 * an unbounded counter or timestamp). Foreign keys and closed domains always
 * carry; a rewriting member carries only while their product falls short of the
 * batch. The rest are generated as usual, so a `.url()` column or a plain string
 * is neither refused nor retagged when the foreign keys already cover the rows. Two foreign keys of N and M parents seed
 * N x M rows and no more — the through-table case. A batch past what the
 * carriers can cover is refused, with the index named.
 *
 * Skipped, leaving the columns to the generator, when a member is already unique on
 * its own (the index is then satisfied), a self-reference (its pool is not known
 * yet), a foreign key with no parents, a server-filled column, or is overridden.
 * ponytail: a column shared by two composite indexes keeps the first deal; one shared digit space if that ever comes up.
 */
const planCompositeDeal = (
    index: UniqueIndexSpec,
    fields: ReadonlyMap<string, FieldSpec>,
    table: string,
    count: number,
    offset: number,
    now: number,
    tableOverrides: Record<string, unknown>,
    poolOf: (field: FieldSpec) => ReadonlyArray<string>,
    deals: Map<string, UniqueDeal>,
): void => {
    // A column named twice holds one value, so it carries one digit, not two.
    const names = [...new Set(index.fields)];
    const members = names.flatMap((name) => fields.get(name) ?? []);
    const undealable = (field: FieldSpec): boolean =>
        field.unique ||
        field.fkTable === table ||
        deals.has(field.name) ||
        Object.hasOwn(tableOverrides, field.name) ||
        (field.hasServerDefault && field.fkTable === undefined) ||
        (field.fkTable !== undefined && poolOf(field).length === 0);

    if (members.length !== names.length || members.some((field) => undealable(field))) {
        return;
    }

    // Foreign keys first, then closed domains, then the members a deal would rewrite; the sort is stable,
    // so declaration order breaks ties.
    const candidates = members
        .map((field) => {
            if (field.fkTable !== undefined) {
                return { carrier: { deal: planUniqueFkDeal(poolOf(field), table, field.name), field }, rank: 0 };
            }

            const member = planCompositeMemberDeal(field, { now, table });

            return member === undefined ? undefined : { carrier: { deal: member.deal, field }, rank: member.rewrites ? 2 : 1 };
        })
        .filter((candidate) => candidate !== undefined)
        .toSorted((left, right) => left.rank - right.rank);
    const required = offset + count;
    const carriers: Carrier[] = [];
    let capacity = 1;

    // Foreign keys and closed domains always carry: their dealt value is one the generator could have
    // produced, and dealing them whatever the batch size keeps a pair a function of the row index, so a
    // later call never repeats one. A rewriting member carries only when those fall short.
    for (const { carrier, rank } of candidates) {
        if (rank === 2 && capacity >= required) {
            break;
        }

        carriers.push(carrier);
        capacity *= carrier.deal.capacity;
    }

    if (required > capacity) {
        throw new LunoraError(
            "BAD_REQUEST",
            `cannot seed ${String(required)} rows into "${table}": unique index "${index.name}" over (${index.fields.join(", ")}) has only ${String(capacity)} distinct combinations`,
        );
    }

    assignDigits(carriers, capacity, deals);
};

/** Deal every multi-column `unique` index of one table; see {@link planCompositeDeal}. */
const planCompositeDeals = (
    uniqueIndexes: ReadonlyArray<UniqueIndexSpec>,
    fields: ReadonlyArray<FieldSpec>,
    table: string,
    count: number,
    offset: number,
    now: number,
    tableOverrides: Record<string, unknown>,
    poolOf: (field: FieldSpec) => ReadonlyArray<string>,
    deals: Map<string, UniqueDeal>,
): void => {
    const byName = new Map(fields.map((field) => [field.name, field]));

    for (const index of uniqueIndexes) {
        planCompositeDeal(index, byName, table, count, offset, now, tableOverrides, poolOf, deals);
    }
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
 * its parent pool, whose size is the capacity; a SELF-referencing one is dealt
 * the preceding row by `generateField` instead, because its pool is the rows this
 * very batch has yet to generate — and is REFUSED once the table
 * already holds rows, since the values they store in that column cannot be read
 * back from the row ids and a repeat would violate the constraint.
 *
 * An overridden column still gets a deal — an override may resolve to
 * `undefined` and defer back to the generator — but its capacity is not
 * asserted, since the caller supplying the values decides their uniqueness.
 */
const planUniqueDeals = (
    fields: ReadonlyArray<FieldSpec>,
    uniqueIndexes: ReadonlyArray<UniqueIndexSpec>,
    table: string,
    count: number,
    offset: number,
    now: number,
    tableOverrides: Record<string, unknown>,
    poolOf: (field: FieldSpec) => ReadonlyArray<string>,
): ReadonlyMap<string, UniqueDeal> => {
    const deals = new Map<string, UniqueDeal>();

    for (const field of fields) {
        if (!field.unique || (field.hasServerDefault && field.fkTable === undefined)) {
            continue;
        }

        if (field.fkTable === table) {
            assertSelfReferenceDealable(field, table, poolOf, tableOverrides);

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

    planCompositeDeals(uniqueIndexes, fields, table, count, offset, now, tableOverrides, poolOf, deals);

    return deals;
};

/** A foreign-key cell a cycle left open for the second pass. */
interface DeferredCell {
    field: FieldSpec;
    /** The row's ABSOLUTE index, which a `.unique()` cell is dealt by. */
    index: number;
    input: ReadonlyArray<unknown>;
    /** `offset + count` of the cell's table: how many distinct values a `.unique()` cell needs. */
    required: number;
    row: Record<string, unknown>;
    table: string;
}

/**
 * The value for one deferred cell, drawn from its parent's ids now that every
 * table has been generated. A `.unique()` cell is dealt from the completed pool
 * as {@link planUniqueDeals} deals any other unique FK, so the outcome does not
 * depend on which table of the cycle was declared first.
 */
const resolveDeferred = (
    { field, index, input, required, table }: DeferredCell,
    idsByTable: ReadonlyMap<string, ReadonlyArray<string>>,
    existingIds: Readonly<Record<string, ReadonlyArray<string>>>,
    allowOrphans: boolean,
    deals: Map<string, UniqueDeal>,
): unknown => {
    const parent = field.fkTable as string;
    const pool = [...(idsByTable.get(parent) ?? []), ...(existingIds[parent] ?? [])];

    if (pool.length === 0) {
        return fkFallback(field, table, input, allowOrphans);
    }

    if (!field.unique) {
        return copycat.oneOf(input, pool);
    }

    const key = JSON.stringify([table, field.name]);
    let deal = deals.get(key);

    if (deal === undefined) {
        deal = planUniqueFkDeal(pool, table, field.name);

        if (required > deal.capacity) {
            throw new LunoraError(
                "BAD_REQUEST",
                `cannot seed ${String(required)} rows into "${table}": unique column "${field.name}" has only ${String(deal.capacity)} possible values`,
            );
        }

        deals.set(key, deal);
    }

    return deal.valueAt(index, () => copycat.oneOf(input, pool));
};

/** Refuse a seed `only` list naming a table the schema does not define. */
const assertKnownTables = (specs: ReadonlyArray<TableSpec>, only: ReadonlyArray<string> | undefined): void => {
    if (only === undefined) {
        return;
    }

    const known = new Set(specs.map((spec) => spec.name));

    for (const name of only) {
        if (!known.has(name)) {
            const available = specs.map((spec) => spec.name).join(", ");

            throw new LunoraError("BAD_REQUEST", `unknown table "${name}" in seed \`only\` — schema defines: ${available || "(no tables)"}`);
        }
    }
};

/**
 * Build a deterministic, FK-consistent set of rows for `schema`.
 * @returns one {@link TablePlan} per seeded table, ordered so a table's FK
 * parents come before it.
 */
const seedPlan = (schema: Schema, options: SeedOptions = {}): ReadonlyArray<TablePlan> => {
    const {
        allowOrphans = false,
        counts = {},
        defaultCount = 10,
        existingIds = {},
        indexOffset = {},
        now = Date.now(),
        only,
        overrides = {},
        seed = 0,
    } = options;

    setHashKey(seed);

    const specs = introspectSchema(schema);

    // Surface an explicit error for a typo'd table rather than silently seeding
    // nothing. The CLI guards `--table` upstream, but the testing adapter and any
    // direct `seedPlan` caller would otherwise get a confusing empty plan.
    assertKnownTables(specs, only);

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
    // Cells whose parent table is generated later in a cycle; filled once every table has ids.
    const deferred: DeferredCell[] = [];
    // A deferred cell is recorded for the second pass; any other generated value passes through.
    const settle = (value: unknown, cell: DeferredCell): unknown => {
        if (value !== DEFERRED) {
            return value;
        }

        deferred.push(cell);

        return undefined;
    };

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

        // An ordinary parent is generated before its children (`orderTables`), so
        // its pool is final here. A cycle parent is scheduled after this table, so
        // its pool is empty now and those cells are filled in the second pass, once
        // every table has ids. `localIndex` only matters for a self-reference.
        const pools = new Map(
            spec.fields.filter((field) => field.fkTable !== undefined).map((field) => [field.name, fkPoolFor(field, table, idsByTable, existingIds, selected)]),
        );
        const uniqueDeals = planUniqueDeals(spec.fields, spec.uniqueIndexes, table, count, offset, now, tableOverrides, (field) =>
            (pools.get(field.name) as (localIndex: number) => ReadonlyArray<string>)(0),
        );

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
                const input = cellInput(seed, table, index, field.name);

                apply(field.name, () =>
                    settle(
                        generateField(field, {
                            allowOrphans,
                            existingIds,
                            idsByTable,
                            index,
                            input,
                            localIndex,
                            now,
                            pools,
                            selected,
                            table,
                            uniqueDeals,
                        }),
                        { field, index, input, required: offset + count, row, table },
                    ),
                );
            }

            rows.push(row);
        }

        plan.push({ rows, table });
    }

    // Second pass: every table now has ids, so each cell a cycle left open can
    // point at a real parent row.
    const deferredDeals = new Map<string, UniqueDeal>();

    for (const cell of deferred) {
        const value = resolveDeferred(cell, idsByTable, existingIds, allowOrphans, deferredDeals);

        if (value !== undefined) {
            cell.row[cell.field.name] = value;
        }
    }

    return plan;
};

export { seedPlan };
export type { OverrideContext, SeedCounts, SeedOptions, SeedOverrides, TablePlan };
