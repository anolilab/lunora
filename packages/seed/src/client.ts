import type { Schema } from "@lunora/server";

import { copycat, setHashKey } from "./copycat";
import type { OverrideContext } from "./plan";
import { seedPlan } from "./plan";

/**
 * A typed, schema-aware seed client — the ergonomic DX layer over {@link seedPlan}.
 *
 * Where `seedPlan` generates every table at once, the client lets you author one
 * table at a time, with autocomplete on each table's columns and live foreign-key
 * connection to whatever was seeded earlier this run. Pass your generated
 * `InsertModel` type as the type argument — or let `lunora/_generated/seed.ts`
 * do that for you — for full type inference on each table's columns.
 *
 * The client is deterministic (same `seed` ⇒ same rows and ids) and pure unless a
 * `persist` hook is supplied, in which case each generated batch is also written
 * through it (the test harness, an admin import, …). Because every row carries an
 * explicit `_id`, the returned ids are known whether or not anything is persisted.
 */

/** Picks a concrete count: a fixed number, or a deterministic value within `[min, max]`. */
type CountHelper = (countOrRange: number | readonly [number, number]) => number;

/** The per-call population spec: a count, an inclusive range, explicit partial rows, or a count callback. */
type SeedSpec<Row> = number | ReadonlyArray<Partial<Row>> | readonly [number, number] | ((x: CountHelper) => number);

/** A per-field override: a fixed value or a function of the row context. */
type FieldOverride<Value> = ((context: OverrideContext) => Value) | Value;

/** Options for a single table call. `overrides` win over any explicit partial rows. */
interface SeedCallOptions<Row> {
    overrides?: { [K in keyof Row]?: FieldOverride<Row[K]> };
}

/** The id columns the client emits, keyed by table — the result of a single table call. */
type SeedCallResult<InsertModel, Table extends keyof InsertModel> = { [K in Table]: string[] };

/** The seeder function exposed for one table. */
type TableSeeder<InsertModel, Table extends keyof InsertModel> = (
    spec?: SeedSpec<InsertModel[Table]>,
    options?: SeedCallOptions<InsertModel[Table]>,
) => Promise<SeedCallResult<InsertModel, Table>>;

/** The `$`-prefixed run state shared by every client. */
interface SeedClientState {
    /** Every id generated this run, keyed by table (includes auto-seeded FK parents). */
    readonly $ids: Readonly<Record<string, ReadonlyArray<string>>>;
    /** Clear all accumulated rows/ids so the client can drive a fresh run. */
    $reset: () => void;
    /** Every row generated this run, keyed by table. */
    readonly $store: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
}

/** The per-table seeder methods plus the `$`-prefixed run state. */
type SeedClient<InsertModel> = SeedClientState & {
    [Table in keyof InsertModel]: TableSeeder<InsertModel, Table>;
};

/** Options for {@link createSeedClient}. */
interface SeedClientOptions {
    /** Default row count when a table call passes no spec (default `10`). */
    defaultCount?: number;

    /**
     * Wall-clock reference for time-valued columns (`createdAt`, `expiresAt`, a
     * `.unique()` date, …), in epoch-ms. Defaults to `Date.now()` **per call**,
     * which is the one input that otherwise drifts between runs — pin it and the
     * client is deterministic in the full sense the docs promise, not merely in
     * its ids.
     */
    now?: number;
    /** Persist each generated batch (e.g. insert through the test harness). Pure when omitted. */
    persist?: (table: string, rows: ReadonlyArray<Record<string, unknown>>) => Promise<void> | void;
    /** Deterministic mapping selector — same seed ⇒ same rows and ids. Default `0`. */
    seed?: number;
}

const isRange = (spec: unknown): spec is readonly [number, number] =>
    Array.isArray(spec) && spec.length === 2 && typeof spec[0] === "number" && typeof spec[1] === "number";

/** Resolve a {@link SeedSpec} into a concrete count and any explicit partial rows. */
const resolveSpec = <Row>(
    spec: SeedSpec<Row> | undefined,
    table: string,
    seed: number,
    defaultCount: number,
): { count: number; partials?: ReadonlyArray<Partial<Row>> } => {
    const pick: CountHelper = (countOrRange) =>
        typeof countOrRange === "number" ? countOrRange : copycat.int([seed, table, "count"], { max: countOrRange[1], min: countOrRange[0] });

    if (spec === undefined) {
        return { count: defaultCount };
    }

    if (typeof spec === "number") {
        return { count: spec };
    }

    if (typeof spec === "function") {
        return { count: spec(pick) };
    }

    if (isRange(spec)) {
        return { count: pick(spec) };
    }

    return { count: spec.length, partials: spec };
};

/**
 * Build the {@link seedPlan} overrides for one table call from explicit partial
 * rows and per-field overrides. Partial rows resolve by their position within
 * this call (`offset` maps the plan's absolute index back to the partial array);
 * explicit `overrides` take precedence over a partial's value for the same field.
 */
const buildOverrides = <Row>(
    partials: ReadonlyArray<Partial<Row>> | undefined,
    fieldOverrides: SeedCallOptions<Row>["overrides"],
    offset: number,
): Record<string, unknown> => {
    const overrides: Record<string, unknown> = {};

    if (partials !== undefined) {
        const fields = new Set(partials.flatMap((partial) => Object.keys(partial as Record<string, unknown>)));

        for (const field of fields) {
            // Returning `undefined` (a partial that omits this field) defers to the generator.
            overrides[field] = (context: OverrideContext) => (partials[context.index - offset] as Record<string, unknown> | undefined)?.[field];
        }
    }

    for (const [field, value] of Object.entries(fieldOverrides ?? {})) {
        overrides[field] = value;
    }

    return overrides;
};

/**
 * Create a typed seed client for `schema`. Each table is a method; call it with a
 * count, a range, or explicit partial rows, and its foreign keys connect to rows
 * seeded earlier this run. State accumulates on `$store`/`$ids` and clears with
 * `$reset()`.
 * @example
 * const seed = createSeedClient<InsertModel>(schema, { seed: 1 });
 * const { users } = await seed.users(5);
 * const { posts } = await seed.posts((x) => x([10, 20]));
 * // posts.authorId values are drawn from `users`.
 */
const createSeedClient = <InsertModel = Record<string, Record<string, unknown>>>(schema: Schema, options: SeedClientOptions = {}): SeedClient<InsertModel> => {
    const { defaultCount = 10, now, persist, seed = 0 } = options;

    const store: Record<string, Record<string, unknown>[]> = {};
    const idsByTable: Record<string, string[]> = {};
    const createdCount: Record<string, number> = {};

    const runSeedTable = async (table: string, spec?: SeedSpec<object>, callOptions?: SeedCallOptions<object>): Promise<Record<string, string[]>> => {
        // A fresh client run shares one mapping; reassert it per call so an
        // interleaved client on a different seed can't shift this one's output.
        setHashKey(seed);

        const { count, partials } = resolveSpec(spec, table, seed, defaultCount);
        const offset = createdCount[table] ?? 0;

        const plan = seedPlan(schema, {
            counts: { [table]: count },
            existingIds: idsByTable,
            indexOffset: { [table]: offset },
            now,
            only: [table],
            overrides: { [table]: buildOverrides(partials, callOptions?.overrides, offset) },
            seed,
        });

        let created: string[] = [];

        for (const { rows, table: planned } of plan) {
            const ids = rows.map((row) => row._id as string);

            store[planned] ??= [];
            store[planned].push(...rows);
            idsByTable[planned] ??= [];
            idsByTable[planned].push(...ids);
            createdCount[planned] = (createdCount[planned] ?? 0) + rows.length;

            if (planned === table) {
                created = ids;
            }

            if (persist !== undefined) {
                // eslint-disable-next-line no-await-in-loop -- parents must persist before children so FKs reference inserted rows
                await persist(planned, rows);
            }
        }

        return { [table]: created };
    };

    // Serialize calls on this client through a promise chain. `runSeedTable` reads
    // `createdCount[table]` for its index offset and then awaits `persist` before
    // the next table's count is recorded; without serialization two overlapping
    // calls (e.g. `Promise.all([seed.posts(5), seed.posts(5)])`) would both read
    // the same offset and generate byte-identical deterministic `_id`s — duplicate
    // primary keys. Chaining also keeps `$store` ordering deterministic.
    let queue: Promise<unknown> = Promise.resolve();

    const seedTable = (table: string, spec?: SeedSpec<object>, callOptions?: SeedCallOptions<object>): Promise<Record<string, string[]>> => {
        const result = queue.then(() => runSeedTable(table, spec, callOptions));

        // Keep the chain alive regardless of this call's outcome so a rejected call
        // never wedges later ones; the caller still observes `result`'s rejection.
        queue = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    };

    const state = {
        $ids: idsByTable,
        $reset: (): void => {
            // Clear all three run-state maps in place (the getters expose these
            // exact references, so they can't be reassigned). Deleting keys keeps
            // the maps empty rather than retaining zero-length entries; either would
            // be correct now that `seedPlan` treats a parent as covered by
            // `existingIds` only when it has a *non-empty* id array (an empty array
            // is not covered), so a reset can never suppress parent auto-generation.
            for (const key of Object.keys(store)) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- clearing dynamic run-state keys
                delete store[key];
            }

            for (const key of Object.keys(idsByTable)) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- clearing dynamic run-state keys
                delete idsByTable[key];
            }

            for (const key of Object.keys(createdCount)) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keep all three run-state maps in lockstep
                delete createdCount[key];
            }
        },
        $store: store,
    };

    return new Proxy(state, {
        get(target, property, receiver): unknown {
            if (typeof property === "string" && !property.startsWith("$") && Object.hasOwn(schema.tables, property)) {
                return (spec?: SeedSpec<object>, callOptions?: SeedCallOptions<object>) => seedTable(property, spec, callOptions);
            }

            return Reflect.get(target, property, receiver);
        },
    }) as unknown as SeedClient<InsertModel>;
};

export { createSeedClient };
export type { CountHelper, SeedCallOptions, SeedCallResult, SeedClient, SeedClientOptions, SeedSpec };
