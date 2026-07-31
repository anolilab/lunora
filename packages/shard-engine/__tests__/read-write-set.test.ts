import { describe, expect, it } from "vitest";

import type { IndexKeyEntry, KeyRange, StagedCondition } from "../src/read-write-set";
import { buildIndexRange, indexKeysForRow, keysTouchRanges, rangeContains } from "../src/read-write-set";
import { serializeSqlValue } from "../src/serialize-sql";

const INDEX = "by_channel_ts";

const FIELDS = ["channelId", "ts"];

const range = (conditions: StagedCondition[], fields: ReadonlyArray<string> = FIELDS): KeyRange | undefined =>
    buildIndexRange("messages", INDEX, fields, conditions, serializeSqlValue);

/** The index position a row occupies under {@link INDEX}. */
const keyFor = (row: Record<string, unknown>): IndexKeyEntry => {
    const [entry] = indexKeysForRow([{ fields: FIELDS, name: INDEX }], row, serializeSqlValue);

    if (!entry) {
        throw new Error("expected the row to have an encodable index key");
    }

    return entry;
};

/** Does a write at `row` fall inside the slice described by `conditions`? */
const touches = (conditions: StagedCondition[], row: Record<string, unknown>): boolean => {
    const built = range(conditions);

    if (!built) {
        throw new Error("expected the conditions to form a provable range");
    }

    return rangeContains(built, keyFor(row));
};

/**
 * Like {@link range}, but throws instead of returning `undefined` — for tests
 * that need the {@link KeyRange} object itself (not just `touches`) over a
 * custom index/fields shape, kept out of the `it()` body so an unprovable
 * range fails as a setup error rather than a conditional test assertion.
 */
const mustBuildRange = (table: string, index: string, fields: ReadonlyArray<string>, conditions: StagedCondition[]): KeyRange => {
    const built = buildIndexRange(table, index, fields, conditions, serializeSqlValue);

    if (!built) {
        throw new Error("expected the conditions to form a provable range");
    }

    return built;
};

/** The index position a row occupies under an arbitrary `index`/`fields` pair. */
const keyForIndex = (index: string, fields: ReadonlyArray<string>, row: Record<string, unknown>): IndexKeyEntry => {
    const [entry] = indexKeysForRow([{ fields, name: index }], row, serializeSqlValue);

    if (!entry) {
        throw new Error("expected the row to have an encodable index key");
    }

    return entry;
};

describe("buildIndexRange", () => {
    it("confines an equality prefix to its own partition", () => {
        expect.assertions(3);

        const eqA: StagedCondition[] = [{ comparator: "=", field: "channelId", value: "A" }];

        expect(touches(eqA, { channelId: "A", ts: 1 })).toBe(true);
        expect(touches(eqA, { channelId: "A", ts: 9999 })).toBe(true);
        // The whole point of the feature: a write to channel B must not wake
        // a subscription reading channel A.
        expect(touches(eqA, { channelId: "B", ts: 1 })).toBe(false);
    });

    it("excludes rows at an exclusive bound even when they carry trailing components", () => {
        expect.assertions(4);

        // The compound-index trap: (A, 5) encodes ABOVE the bare bound
        // enc(A)!enc(5), so a naive exclusive upper bound would still admit it.
        const beforeFive: StagedCondition[] = [
            { comparator: "=", field: "channelId", value: "A" },
            { comparator: "<", field: "ts", value: 5 },
        ];

        expect(touches(beforeFive, { channelId: "A", ts: 4 })).toBe(true);
        expect(touches(beforeFive, { channelId: "A", ts: 5 })).toBe(false);

        const afterFive: StagedCondition[] = [
            { comparator: "=", field: "channelId", value: "A" },
            { comparator: ">", field: "ts", value: 5 },
        ];

        expect(touches(afterFive, { channelId: "A", ts: 5 })).toBe(false);
        expect(touches(afterFive, { channelId: "A", ts: 6 })).toBe(true);
    });

    it("admits a string value that extends an exclusive lower bound as a prefix", () => {
        expect.assertions(4);

        const nameFields = ["name"];
        const nameIndex = "by_name";
        const built = mustBuildRange("users", nameIndex, nameFields, [{ comparator: ">", field: "name", value: "Al" }]);
        const keyForName = (row: Record<string, unknown>): IndexKeyEntry => keyForIndex(nameIndex, nameFields, row);

        // "Alice" EXTENDS the bound "Al" as a prefix — SQLite's BINARY order
        // puts it INSIDE gt("name", "Al"), so an exclusive-bound encoding that
        // merely excludes everything sorting above the bare bound would drop
        // it and leave a write to this row permanently unmatched.
        expect(rangeContains(built, keyForName({ name: "Alice" }))).toBe(true);
        // The bound itself is excluded (`>`, not `>=`).
        expect(rangeContains(built, keyForName({ name: "Al" }))).toBe(false);
        // Lexicographically below the bound.
        expect(rangeContains(built, keyForName({ name: "Aa" }))).toBe(false);
        // Sanity: something clearly above the bound.
        expect(rangeContains(built, keyForName({ name: "Bob" }))).toBe(true);
    });

    it("admits a compound row whose trailing field extends an exclusive bound as a prefix", () => {
        expect.assertions(2);

        const compoundFields = ["channelId", "name"];
        const compoundIndex = "by_channel_name";
        const built = mustBuildRange("members", compoundIndex, compoundFields, [
            { comparator: "=", field: "channelId", value: "A" },
            { comparator: ">", field: "name", value: "Al" },
        ]);
        const keyForCompound = (row: Record<string, unknown>): IndexKeyEntry => keyForIndex(compoundIndex, compoundFields, row);

        expect(rangeContains(built, keyForCompound({ channelId: "A", name: "Alice" }))).toBe(true);
        expect(rangeContains(built, keyForCompound({ channelId: "A", name: "Al" }))).toBe(false);
    });

    it("admits rows exactly at an inclusive bound", () => {
        expect.assertions(2);

        const atLeastFive: StagedCondition[] = [
            { comparator: "=", field: "channelId", value: "A" },
            { comparator: ">=", field: "ts", value: 5 },
        ];

        expect(touches(atLeastFive, { channelId: "A", ts: 5 })).toBe(true);

        const atMostFive: StagedCondition[] = [
            { comparator: "=", field: "channelId", value: "A" },
            { comparator: "<=", field: "ts", value: 5 },
        ];

        expect(touches(atMostFive, { channelId: "A", ts: 5 })).toBe(true);
    });

    it("bounds a two-sided window on both ends", () => {
        expect.assertions(4);

        const window: StagedCondition[] = [
            { comparator: "=", field: "channelId", value: "A" },
            { comparator: ">=", field: "ts", value: 10 },
            { comparator: "<", field: "ts", value: 20 },
        ];

        expect(touches(window, { channelId: "A", ts: 9 })).toBe(false);
        expect(touches(window, { channelId: "A", ts: 10 })).toBe(true);
        expect(touches(window, { channelId: "A", ts: 19 })).toBe(true);
        expect(touches(window, { channelId: "A", ts: 20 })).toBe(false);
    });

    it("covers the whole index when no condition is staged", () => {
        expect.assertions(2);

        const everything = range([]);

        expect(everything).toBeDefined();
        expect(rangeContains(everything as KeyRange, keyFor({ channelId: "Z", ts: -5 }))).toBe(true);
    });

    it("refuses to narrow when the conditions are not a provable contiguous slice", () => {
        expect.assertions(5);

        // Equality on the SECOND field without the first: not a prefix.
        expect(range([{ comparator: "=", field: "ts", value: 1 }])).toBeUndefined();
        // A field outside the index.
        expect(range([{ comparator: "=", field: "authorId", value: "u1" }])).toBeUndefined();
        // A comparator the builder does not model.
        expect(range([{ comparator: "!=", field: "channelId", value: "A" }])).toBeUndefined();
        // An unencodable bound.
        expect(range([{ comparator: "=", field: "channelId", value: Number.NaN }])).toBeUndefined();
        // An equality AFTER a range bound is no longer contiguous.
        expect(
            range([
                { comparator: ">", field: "channelId", value: "A" },
                { comparator: "=", field: "ts", value: 1 },
            ]),
        ).toBeUndefined();
    });

    it("refuses an empty slice rather than emitting a range nothing can enter", () => {
        expect.assertions(1);

        expect(
            range([
                { comparator: "=", field: "channelId", value: "A" },
                { comparator: ">=", field: "ts", value: 20 },
                { comparator: "<", field: "ts", value: 10 },
            ]),
        ).toBeUndefined();
    });
});

describe("indexKeysForRow", () => {
    it("omits indexes whose key cannot be encoded", () => {
        expect.assertions(2);

        const entries = indexKeysForRow(
            [
                { fields: ["channelId"], name: "by_channel" },
                { fields: ["score"], name: "by_score" },
            ],
            { channelId: "A", score: Number.NaN },
            serializeSqlValue,
        );

        expect(entries).toHaveLength(1);
        expect(entries[0]?.index).toBe("by_channel");
    });

    it("canonicalises booleans the same way the where-compiler binds them", () => {
        expect.assertions(1);

        const asBoolean = indexKeysForRow([{ fields: ["done"], name: "by_done" }], { done: true }, serializeSqlValue);
        const asNumber = indexKeysForRow([{ fields: ["done"], name: "by_done" }], { done: 1 }, serializeSqlValue);

        expect(asBoolean[0]?.key).toBe(asNumber[0]?.key);
    });
});

describe("keysTouchRanges", () => {
    it("reports no contact when every write lands outside every slice", () => {
        expect.assertions(1);

        const inChannelA = range([{ comparator: "=", field: "channelId", value: "A" }]) as KeyRange;

        expect(keysTouchRanges([inChannelA], [keyFor({ channelId: "B", ts: 1 })])).toBe(false);
    });

    it("assumes contact whenever either side is unknown", () => {
        expect.assertions(3);

        const inChannelA = range([{ comparator: "=", field: "channelId", value: "A" }]) as KeyRange;

        expect(keysTouchRanges(undefined, [keyFor({ channelId: "B", ts: 1 })])).toBe(true);
        expect(keysTouchRanges([inChannelA], undefined)).toBe(true);
        expect(keysTouchRanges([inChannelA], [])).toBe(true);
    });

    it("assumes contact when the write carries no key for the index the query read", () => {
        expect.assertions(1);

        const inChannelA = range([{ comparator: "=", field: "channelId", value: "A" }]) as KeyRange;

        // The row's key for a DIFFERENT index proves nothing about this slice.
        expect(keysTouchRanges([inChannelA], [{ index: "by_author", key: "2ff" }])).toBe(true);
    });
});
