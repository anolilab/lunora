import type { DatabaseWriterLike, SchemaLike, TableReaderLike, ValidatorLike, WhereInput } from "@lunora/shard-engine";
import { whereFilter } from "@lunora/shard-engine";
import { expect } from "vitest";

/**
 * A read policy on a `.global()` table's search reader, against a real engine.
 *
 * `rls()` guards `ctx.db.query(t)` with `reader.filter(whereFilter(policy,
 * matcher))`; these cases install exactly that. Each one checks two things:
 *
 * - **the boundary** — every terminal (`take` / `first` / `unique` / `collect` /
 * `paginate` across cursors / the iterator) returns exactly the rows the policy
 * admits, whether the engine pushed the policy into its SQL or not;
 * - **the cost** — a guarded `take(5)` over 510 matches hands back a handful of
 * rows when the policy is pushed, not the whole relevance window.
 *
 * Handed back as `[name, run]` pairs for each suite's own `it.each`, like
 * `search-races`.
 */
interface RlsSearchTarget {
    /**
     * Drop, provision and return a writer over `schema` whose every read reports
     * the rows the engine handed back to `onRows`.
     */
    setup: (schema: SchemaLike, onRows: (count: number) => void) => Promise<DatabaseWriterLike>;
    /** Whether string comparisons are pushed on this engine (not on MySQL). */
    textPushed: boolean;
}

type Row = Record<string, unknown>;

const ROWS = 510;

const column = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: [], name: "by_body" }],
            shape: {
                body: column("string"),
                hidden: column("boolean"),
                // Nullable: absent on every fourth row.
                label: { _meta: { column: {}, inner: { kind: "string" } }, kind: "optional" },
                ownerId: column("string"),
                tier: column("number"),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

const pad = (n: number): string => `r${String(n).padStart(4, "0")}`;

const LABELS = [undefined, "x", "y", undefined] as const;

/** Every row matches "alpha"; the first four also match "solo". */
const corpus = (): Row[] =>
    Array.from({ length: ROWS }, (_, n) => {
        const label = LABELS[n % 4];

        return {
            _id: pad(n),
            body: n < 4 ? "alpha solo" : "alpha",
            hidden: n % 5 === 0,
            ownerId: n % 2 === 0 ? "u1" : "u2",
            tier: n % 3,
            ...(label === undefined ? {} : { label }),
        };
    });

/** A NULL cell never passes `ne` / `notIn`, in SQL or in the matcher. */
const labelIsNot = (row: Row, value: string): boolean => row["label"] !== undefined && row["label"] !== null && row["label"] !== value;

const SOME_IDS = Array.from({ length: 20 }, (_, n) => pad(n * 3 + 2));

interface Policy {
    admits: (row: Row) => boolean;
    name: string;
    /** Pushed into SQL on this engine? */
    pushed: (target: RlsSearchTarget) => boolean;
    where: WhereInput;
}

const POLICIES: Policy[] = [
    { admits: (row) => row["tier"] === 1, name: "number equality", pushed: () => true, where: { tier: 1 } },
    {
        admits: (row) => row["ownerId"] === "u1" && row["tier"] === 1,
        name: "string + number equality",
        pushed: (target) => target.textPushed,
        where: { ownerId: "u1", tier: { in: [1] } },
    },
    {
        admits: (row) => row["tier"] === 1 && row["hidden"] !== true,
        name: "NOT (never pushed)",
        pushed: () => false,
        where: { NOT: { hidden: true }, tier: 1 },
    },
    {
        // `allowAll()` is `{}`: the OR is TRUE whatever its other branch says.
        admits: (row) => row["tier"] === 1,
        name: "allowAll() branch",
        pushed: () => true,
        where: { AND: [{ OR: [{}, { tier: 7 }] }, { tier: 1 }] },
    },
    { admits: (row) => labelIsNot(row, "x"), name: "nullable ne", pushed: (target) => target.textPushed, where: { label: { ne: "x" } } },
    {
        admits: (row) => labelIsNot(row, "x"),
        name: "nullable notIn",
        pushed: (target) => target.textPushed,
        where: { label: { notIn: ["x"] } },
    },
    {
        admits: (row) => (row["label"] === undefined || row["label"] === null) && row["tier"] === 1,
        name: "nullable isNull",
        // `label` is a string column, so MySQL keeps even `isNull` on it in memory.
        pushed: (target) => target.textPushed,
        where: { label: { isNull: true }, tier: 1 },
    },
    { admits: (row) => SOME_IDS.includes(String(row["_id"])), name: "_id in", pushed: (target) => target.textPushed, where: { _id: { in: SOME_IDS } } },
];

const idsOf = (rows: ReadonlyArray<Row>): string[] => rows.map((row) => String(row["_id"]));

/** Relevance ties break on `_creationTime DESC`, and rows are inserted in id order. */
const expectedIds = (policy: Policy, term: "alpha" | "solo"): string[] =>
    corpus()
        .filter((row) => policy.admits(row) && (term === "alpha" || String(row["body"]).includes("solo")))
        .map((row) => String(row["_id"]))
        .toReversed();

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (const row of corpus()) {
        // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in id order
        await writer.insert("notes", row, { allowExplicitId: true });
    }
};

const guarded = (writer: DatabaseWriterLike, policy: Policy, term: "alpha" | "solo"): TableReaderLike =>
    writer
        .query("notes")
        .filter(whereFilter(policy.where, policy.admits))
        .withSearchIndex("by_body", (q) => q.search("body", term));

/** No row the policy hides, and no row it admits missing. */
const expectExactly = (rows: ReadonlyArray<Row>, policy: Policy, expected: ReadonlyArray<string>): void => {
    expect(rows.every((row) => policy.admits(row))).toBe(true);
    expect(idsOf(rows)).toStrictEqual(expected);
};

const boundaryCase = (target: RlsSearchTarget, policy: Policy) => async (): Promise<void> => {
    const writer = await target.setup(schema, () => undefined);

    await seed(writer);

    const all = expectedIds(policy, "alpha");
    const solo = expectedIds(policy, "solo");

    expect(solo.length).toBeLessThanOrEqual(1);

    expectExactly(await guarded(writer, policy, "alpha").take(5), policy, all.slice(0, 5));
    const first = await guarded(writer, policy, "alpha").first();

    expectExactly([first as Row], policy, all.slice(0, 1));
    const unique = await guarded(writer, policy, "solo").unique();

    expect(unique?.["_id"] ?? null).toBe(solo[0] ?? null);

    expectExactly(await guarded(writer, policy, "alpha").collect(), policy, all);

    const paged: Row[] = [];
    let cursor: null | string = null;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous one
        const page = await guarded(writer, policy, "alpha").paginate({ cursor, numItems: 40 });

        paged.push(...page.page);

        if (page.isDone) {
            break;
        }

        cursor = page.continueCursor;
    }

    expectExactly(paged, policy, all);

    const iterated: Row[] = [];

    for await (const row of guarded(writer, policy, "alpha")) {
        iterated.push(row);
    }

    expectExactly(iterated, policy, all);
};

const costCase = (target: RlsSearchTarget, policy: Policy) => async (): Promise<void> => {
    let read = 0;
    const tally = (count: number): void => {
        read += count;
    };
    const writer = await target.setup(schema, tally);

    await seed(writer);
    // Warm the migration pass, so only the terminal is counted.
    await writer
        .query("notes")
        .withSearchIndex("by_body", (q) => q.search("body", "solo"))
        .take(1);

    read = 0;

    const rows = await guarded(writer, policy, "alpha").take(5);

    expect(rows).toHaveLength(5);
    // Pushed: the five rows plus the index-coverage probe. Not pushed: every
    // match, plus the probe, for the policy to filter. Before the push-down
    // every policy read the 511.
    expect(read).toBe(policy.pushed(target) ? 6 : ROWS + 1);
};

const rlsSearchCases = (target: RlsSearchTarget): [string, () => Promise<void>][] => [
    ...POLICIES.map((policy): [string, () => Promise<void>] => [
        `every terminal returns exactly the rows a ${policy.name} policy admits`,
        boundaryCase(target, policy),
    ]),
    ...POLICIES.map((policy): [string, () => Promise<void>] => [`a guarded take(5) under a ${policy.name} policy`, costCase(target, policy)]),
];

export type { RlsSearchTarget };
export default rlsSearchCases;
