/**
 * The subscription refresh gate decides whether a live query re-runs. Its whole
 * risk profile is one-sided: skipping a needed re-run leaves a subscriber on
 * stale data indefinitely, while a surplus re-run costs one query. So most of
 * these tests assert that uncertainty resolves to "re-run".
 */
import { describe, expect, it } from "vitest";

import { createReadFootprint } from "../src/read-footprint";
import type { IndexKeyEntry, KeyRange } from "../src/read-write-set";
import type { ChangedKeys } from "../src/subscription-range-gate";
import { mergeChangedKeys, recordChangedKeys, writeTouchesMemo } from "../src/subscription-range-gate";

const range = (table: string, lo: string, hi: string, index = "by_channel"): KeyRange => {
    return { hi, index, lo, table };
};

const key = (value: string, index = "by_channel"): IndexKeyEntry => {
    return { index, key: value };
};

/** A memo that read `table` only through `ranges`. */
const narrowed = (table: string, ...ranges: KeyRange[]) => {
    return {
        ranges: new Map([[table, ranges]]),
        tables: new Set([table]),
    };
};

describe("writeTouchesMemo", () => {
    const inA = narrowed("messages", range("messages", "A", "B"));

    it("skips a re-run when every write landed outside the read slice", () => {
        expect.assertions(1);

        const changed: ChangedKeys = new Map([["messages", [key("C")]]]);

        expect(writeTouchesMemo(inA, new Set(["messages"]), changed)).toBe(false);
    });

    it("re-runs when a write landed inside the slice", () => {
        expect.assertions(1);

        const changed: ChangedKeys = new Map([["messages", [key("A")]]]);

        expect(writeTouchesMemo(inA, new Set(["messages"]), changed)).toBe(true);
    });

    it("re-runs when the write position is unknown", () => {
        expect.assertions(1);

        // A delete, or any raw-SQL write, cannot report a position.
        const changed: ChangedKeys = new Map([["messages", undefined]]);

        expect(writeTouchesMemo(inA, new Set(["messages"]), changed)).toBe(true);
    });

    it("re-runs when nothing about the batch's positions is known", () => {
        expect.assertions(1);

        expect(writeTouchesMemo(inA, new Set(["messages"]), undefined)).toBe(true);
    });

    it("re-runs when the memo never narrowed the written table", () => {
        expect.assertions(2);

        const scanned = { ranges: undefined, tables: new Set(["messages"]) };
        const changed: ChangedKeys = new Map([["messages", [key("C")]]]);

        expect(writeTouchesMemo(scanned, new Set(["messages"]), changed)).toBe(true);
        // An empty slice list is "narrowed to nothing", which we must not read
        // as "narrowed, and nothing matched".
        expect(writeTouchesMemo(narrowed("messages"), new Set(["messages"]), changed)).toBe(true);
    });

    it("re-runs when the write carries no key for the index the query read", () => {
        expect.assertions(1);

        const changed: ChangedKeys = new Map([["messages", [key("A", "by_author")]]]);

        expect(writeTouchesMemo(inA, new Set(["messages"]), changed)).toBe(true);
    });

    it("ignores writes to tables the query never read", () => {
        expect.assertions(1);

        const changed: ChangedKeys = new Map([["users", undefined]]);

        expect(writeTouchesMemo(inA, new Set(["users"]), changed)).toBe(false);
    });

    it("re-runs when ANY read table is touched, not only the first", () => {
        expect.assertions(1);

        const memo = {
            ranges: new Map([
                ["messages", [range("messages", "A", "B")]],
                ["users", [range("users", "A", "B", "by_org")]],
            ]),
            tables: new Set(["messages", "users"]),
        };
        const changed: ChangedKeys = new Map([
            ["messages", [key("C")]],
            ["users", [key("A", "by_org")]],
        ]);

        expect(writeTouchesMemo(memo, new Set(["messages", "users"]), changed)).toBe(true);
    });
});

describe("recordChangedKeys", () => {
    it("accumulates positions across several writes to one table", () => {
        expect.assertions(1);

        let acc = recordChangedKeys(undefined, "messages", [key("A")]);

        acc = recordChangedKeys(acc, "messages", [key("B")]);

        expect(acc.get("messages")).toStrictEqual([key("A"), key("B")]);
    });

    it("marks a table unknown when a write reports no positions", () => {
        expect.assertions(1);

        const acc = recordChangedKeys(undefined, "messages", undefined);

        expect(acc.get("messages")).toBeUndefined();
    });

    it("never narrows a table back once it is unknown", () => {
        expect.assertions(1);

        // A delete followed by an insert must leave the table unnarrowable:
        // the delete's position was never observed.
        let acc = recordChangedKeys(undefined, "messages", undefined);

        acc = recordChangedKeys(acc, "messages", [key("A")]);

        expect(acc.get("messages")).toBeUndefined();
    });

    it("treats an empty key list as unknown, not as 'touched nothing'", () => {
        expect.assertions(1);

        const acc = recordChangedKeys(undefined, "messages", []);

        expect(acc.get("messages")).toBeUndefined();
    });
});

describe("mergeChangedKeys", () => {
    it("unions positions for a table present in both batches", () => {
        expect.assertions(1);

        const pending: ChangedKeys = new Map([["messages", [key("A")]]]);
        const incoming: ChangedKeys = new Map([["messages", [key("B")]]]);

        expect(mergeChangedKeys(pending, incoming, new Set(["messages"])).get("messages")).toStrictEqual([key("A"), key("B")]);
    });

    it("stays unknown when either side is unknown", () => {
        expect.assertions(2);

        const known: ChangedKeys = new Map([["messages", [key("A")]]]);
        const unknown: ChangedKeys = new Map([["messages", undefined]]);

        expect(mergeChangedKeys(known, unknown, new Set(["messages"])).get("messages")).toBeUndefined();
        expect(mergeChangedKeys(unknown, known, new Set(["messages"])).get("messages")).toBeUndefined();
    });

    it("marks a written table unknown when the incoming batch never mentioned it", () => {
        expect.assertions(1);

        // The table was written (it is in `changed`) but no position was
        // recorded for it — that is missing information, not an empty set.
        const pending: ChangedKeys = new Map([["messages", [key("A")]]]);

        expect(mergeChangedKeys(pending, new Map(), new Set(["messages"])).get("messages")).toBeUndefined();
    });

    it("seeds an empty batch as unknown for every written table", () => {
        expect.assertions(1);

        expect(mergeChangedKeys(undefined, undefined, new Set(["messages"])).get("messages")).toBeUndefined();
    });
});

describe("createReadFootprint", () => {
    it("narrows a table read only through ranges", () => {
        expect.assertions(2);

        const footprint = createReadFootprint();

        footprint.onReadRange(range("messages", "A", "B"));

        expect(footprint.tables).toStrictEqual(new Set(["messages"]));
        expect(footprint.ranges()?.get("messages")).toHaveLength(1);
    });

    it("refuses to narrow a table that was ALSO read some other way", () => {
        expect.assertions(2);

        // The correctness hinge: a query that read an index slice AND scanned
        // the same table depends on rows the slice does not name.
        const footprint = createReadFootprint();

        footprint.onReadRange(range("messages", "A", "B"));
        footprint.onRead("messages", "*scan");

        expect(footprint.tables).toStrictEqual(new Set(["messages"]));
        expect(footprint.ranges()).toBeUndefined();
    });

    it("refuses to narrow a table that was also read by row id", () => {
        expect.assertions(1);

        // A by-id read depends on that row wherever it sits in the index, which
        // may be outside every recorded slice.
        const footprint = createReadFootprint();

        footprint.onReadRange(range("messages", "A", "B"));
        footprint.onRead("messages", "doc_1");

        expect(footprint.ranges()).toBeUndefined();
    });

    it("keeps a narrowed table when a DIFFERENT table was scanned", () => {
        expect.assertions(2);

        const footprint = createReadFootprint();

        footprint.onReadRange(range("messages", "A", "B"));
        footprint.onRead("users", "*scan");

        expect(footprint.ranges()?.has("messages")).toBe(true);
        expect(footprint.ranges()?.has("users")).toBe(false);
    });

    it("reports nothing narrowable when no range was read", () => {
        expect.assertions(1);

        const footprint = createReadFootprint();

        footprint.onRead("messages", "*scan");

        expect(footprint.ranges()).toBeUndefined();
    });
});
