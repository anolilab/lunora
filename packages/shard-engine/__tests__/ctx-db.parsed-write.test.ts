import { v } from "@lunora/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * What a row holds after a write through `ctx.db`, for a table declared with
 * real `@lunora/values` validators.
 *
 * A `v.from(schema)` column is typed as the schema's OUTPUT on read, so what is
 * stored must be that output. The writer used to run `parse()` only to enforce
 * it and then store the caller's raw input, so a transforming schema (a numeric
 * string parsed to a number) read back as the string its type denies.
 *
 * The other half of the contract is what must NOT change: bigint, bytes, plain
 * optional and nullable columns keep storing exactly what they stored before, and
 * a stored output is never fed back through its transform (a patch of one field,
 * a data-migration rewrite, an import).
 */
const numericString = {
    "~standard": {
        validate: (value: unknown) =>
            typeof value === "string" && /^\d+$/u.test(value) ? { value: Number(value) } : { issues: [{ message: "expected a numeric string" }] },
        vendor: "test",
        version: 1 as const,
    },
};

const lowercased = {
    "~standard": {
        validate: (value: unknown) => (typeof value === "string" ? { value: value.toLowerCase() } : { issues: [{ message: "expected a string" }] }),
        vendor: "test",
        version: 1 as const,
    },
};

const reversedBytes = {
    "~standard": {
        validate: (value: unknown) =>
            value instanceof ArrayBuffer
                ? { value: new Uint8Array([...new Uint8Array(value)].toReversed()).buffer }
                : { issues: [{ message: "expected bytes" }] },
        vendor: "test",
        version: 1 as const,
    },
};

const schema = {
    tables: {
        plain: { indexes: [], shape: { label: v.string() } },
        nested: {
            indexes: [],
            shape: {
                box: v.object({ n: v.from(numericString), tag: v.string() }),
                deep: v.optional(v.optional(v.from(numericString))),
                label: v.string(),
                scores: v.array(v.from(numericString)),
                // Filled by an update hook with the numeric STRING the schema accepts.
                stamp: v
                    .from(numericString)
                    .$defaultFn(() => "1")
                    .$onUpdateFn(() => "5"),
            },
        },
        // Only the KEYS carry a transform; the values are plain strings.
        labelled: { indexes: [], shape: { labels: v.record(v.from(lowercased) as unknown as ReturnType<typeof v.string>, v.string()), title: v.string() } },
        // A transform over bytes: the stored output is the input reversed.
        payloads: {
            indexes: [],
            shape: { label: v.string(), payload: v.from(reversedBytes) },
        },
        items: {
            indexes: [],
            shape: {
                balance: v.bigint(),
                blob: v.bytes(),
                label: v.string(),
                maybeScore: v.optional(v.from(numericString)),
                note: v.string().nullable(),
                optionalLabel: v.optional(v.string()),
                score: v.from(numericString),
            },
        },
    },
} as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;
let writer: DatabaseWriterLike;

const bytesOf = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

/** A well-formed input row; `score` is the numeric STRING the schema transforms. */
const input = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return { balance: 9_007_199_254_740_993n, blob: bytesOf(1, 2, 3), label: "a", note: null, score: "42", ...overrides };
};

const read = async (id: string): Promise<Record<string, unknown>> => {
    const row = await writer.get(id);

    if (row === null) {
        throw new Error(`row ${id} missing`);
    }

    return row;
};

/** One column of a stored row. */
const stored = async (id: string, field: string): Promise<unknown> => {
    const row = await read(id);

    return row[field];
};

describe("ctx.db writes store the parsed output of v.from columns", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("insert stores the transformed value, for a required and an optional column", async () => {
        expect.assertions(2);

        const id = await writer.insert("items", input({ maybeScore: "7" }));
        const row = await read(id);

        expect(row["score"]).toBe(42);
        expect(row["maybeScore"]).toBe(7);
    });

    it("insert still rejects a value the schema refuses", async () => {
        expect.assertions(1);

        await expect(writer.insert("items", input({ score: "not a number" }))).rejects.toThrow(/numeric string/iu);
    });

    it("patch stores the transformed value of a field it sets", async () => {
        expect.assertions(1);

        const id = await writer.insert("items", input());

        await writer.patch(id, { score: "9" });

        await expect(stored(id, "score")).resolves.toBe(9);
    });

    it("patch of another field leaves a stored transform output alone instead of re-running it", async () => {
        expect.assertions(2);

        const id = await writer.insert("items", input());

        // `score` is already the number 42; re-validating it as a numeric string would throw.
        await expect(writer.patch(id, { label: "b" })).resolves.toBeUndefined();
        await expect(stored(id, "score")).resolves.toBe(42);
    });

    it("replace stores the transformed value", async () => {
        expect.assertions(1);

        const id = await writer.insert("items", input());

        await writer.replace(id, input({ score: "11" }));

        await expect(stored(id, "score")).resolves.toBe(11);
    });

    it("a trusted replay (allowExplicitId) stores already-stored output as given", async () => {
        expect.assertions(3);

        // Import, CDC apply and data-migration rewrites all replay a STORED row:
        // `score` is the number, not the string the schema accepts.
        const id = await writer.insert("items", input({ _id: "i1", score: 5 }), { allowExplicitId: true });

        await expect(stored(id, "score")).resolves.toBe(5);

        await writer.replace(id, input({ score: 6 }), undefined, { allowExplicitId: true });

        await expect(stored(id, "score")).resolves.toBe(6);

        // The untrusted path still refuses the same value.
        await expect(writer.insert("items", input({ score: 5 }))).rejects.toThrow(/numeric string/iu);
    });
});

describe("ctx.db writes leave every other column's stored value as it was", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("round-trips bigint and bytes through insert, patch and replace", async () => {
        expect.assertions(6);

        const id = await writer.insert("items", input());
        const inserted = await read(id);

        expect(inserted["balance"]).toBe(9_007_199_254_740_993n);
        expect(new Uint8Array(inserted["blob"] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));

        await writer.patch(id, { balance: -5n, blob: bytesOf(9) });

        const patched = await read(id);

        expect(patched["balance"]).toBe(-5n);
        expect(new Uint8Array(patched["blob"] as ArrayBuffer)).toEqual(new Uint8Array([9]));

        await writer.replace(id, input({ balance: 12n, blob: bytesOf(7, 7) }));

        const replaced = await read(id);

        expect(replaced["balance"]).toBe(12n);
        expect(new Uint8Array(replaced["blob"] as ArrayBuffer)).toEqual(new Uint8Array([7, 7]));
    });

    it("does not rewrite a Uint8Array into an ArrayBuffer", async () => {
        expect.assertions(1);

        // `v.bytes()` normalises a view when it PARSES; adopting that result would
        // change what a bytes column stores, so only `v.from` output is adopted.
        const id = await writer.insert("items", input({ blob: new Uint8Array([4, 5]) }));

        await expect(stored(id, "blob")).resolves.toBeInstanceOf(Uint8Array);
    });

    it("keeps optional and nullable columns exactly as supplied", async () => {
        expect.assertions(4);

        const id = await writer.insert("items", input({ note: "hello", optionalLabel: "x" }));

        await expect(read(id)).resolves.toMatchObject({ note: "hello", optionalLabel: "x" });

        await writer.patch(id, { note: null });

        await expect(stored(id, "note")).resolves.toBeNull();

        const bare = await read(await writer.insert("items", input()));

        expect(bare["note"]).toBeNull();
        expect("optionalLabel" in bare).toBe(false);
    });
});

/** A `nested` row as the caller supplies it: every `v.from` inside is still the input string. */
const nestedInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return { box: { n: "3", tag: "t" }, deep: "4", label: "a", scores: ["1", "2"], ...overrides };
};

describe("ctx.db stores the parsed output of a v.from nested inside another validator", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("insert stores the transformed value inside an array, an object and a doubly-wrapped optional", async () => {
        expect.assertions(3);

        const row = await read(await writer.insert("nested", nestedInput()));

        expect(row["scores"]).toEqual([1, 2]);
        expect(row["box"]).toEqual({ n: 3, tag: "t" });
        expect(row["deep"]).toBe(4);
    });

    it("patch and replace store the transformed value of a nested column they set", async () => {
        expect.assertions(3);

        const id = await writer.insert("nested", nestedInput());

        await writer.patch(id, { scores: ["8", "9"] });

        await expect(stored(id, "scores")).resolves.toEqual([8, 9]);

        await writer.replace(id, nestedInput({ box: { n: "6", tag: "u" }, deep: "7" }));

        await expect(stored(id, "box")).resolves.toEqual({ n: 6, tag: "u" });
        await expect(stored(id, "deep")).resolves.toBe(7);
    });

    it("a trusted replay stores the nested output as given", async () => {
        expect.assertions(1);

        const id = await writer.insert("nested", nestedInput({ _id: "n1", box: { n: 3, tag: "t" }, deep: 4, scores: [1, 2], stamp: 1 }), {
            allowExplicitId: true,
        });

        await expect(stored(id, "scores")).resolves.toEqual([1, 2]);
    });
});

describe("ctx.db read-modify-write of a row holding parsed columns", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("replace of the spread row passes unchanged output through and still parses a new input", async () => {
        expect.assertions(4);

        const id = await writer.insert("items", input({ maybeScore: "7" }));
        const current = await read(id);

        await writer.replace(id, { ...current, label: "b" });

        await expect(read(id)).resolves.toMatchObject({ label: "b", maybeScore: 7, score: 42 });

        await writer.replace(id, { ...(await read(id)), score: "50" });

        await expect(stored(id, "score")).resolves.toBe(50);
        await expect(writer.replace(id, { ...(await read(id)), score: "nope" })).rejects.toThrow(/numeric string/iu);
        await expect(stored(id, "score")).resolves.toBe(50);
    });

    it("patch of the spread row passes unchanged output through and still parses a new input", async () => {
        expect.assertions(3);

        const id = await writer.insert("items", input());

        await writer.patch(id, { ...(await read(id)), label: "b" });

        await expect(read(id)).resolves.toMatchObject({ label: "b", score: 42 });

        await writer.patch(id, { ...(await read(id)), score: "60" });

        await expect(stored(id, "score")).resolves.toBe(60);
        await expect(writer.patch(id, { ...(await read(id)), score: "nope" })).rejects.toThrow(/numeric string/iu);
    });

    it("replace of the spread row keeps nested output too", async () => {
        expect.assertions(2);

        const id = await writer.insert("nested", nestedInput());

        await writer.replace(id, { ...(await read(id)), label: "b" });

        await expect(read(id)).resolves.toMatchObject({ box: { n: 3, tag: "t" }, deep: 4, label: "b", scores: [1, 2] });

        await writer.replace(id, { ...(await read(id)), scores: ["5"] });

        await expect(stored(id, "scores")).resolves.toEqual([5]);
    });
});

describe("ctx.db runs an update hook's value through the column's transform", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("patch of another field stores the hook's value as the transform's output", async () => {
        expect.assertions(2);

        const id = await writer.insert("nested", nestedInput());

        await expect(stored(id, "stamp")).resolves.toBe(1);

        await writer.patch(id, { label: "b" });

        await expect(stored(id, "stamp")).resolves.toBe(5);
    });
});

describe("ctx.db treats bytes by content when deciding whether a transform column is stored output", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    const bytes = async (id: string): Promise<number[]> => [...new Uint8Array((await stored(id, "payload")) as ArrayBuffer)];

    it("patch and replace parse a NEW buffer instead of persisting it as stored output", async () => {
        expect.assertions(3);

        const id = await writer.insert("payloads", { label: "a", payload: bytesOf(1, 2, 3) });

        await expect(bytes(id)).resolves.toEqual([3, 2, 1]);

        await writer.patch(id, { payload: bytesOf(4, 5, 6) });

        await expect(bytes(id)).resolves.toEqual([6, 5, 4]);

        await writer.replace(id, { label: "a", payload: bytesOf(7, 8, 9) });

        await expect(bytes(id)).resolves.toEqual([9, 8, 7]);
    });

    it("a buffer holding the stored bytes is still passed through unparsed", async () => {
        expect.assertions(2);

        const id = await writer.insert("payloads", { label: "a", payload: bytesOf(1, 2, 3) });

        await writer.patch(id, { payload: bytesOf(3, 2, 1) });

        await expect(bytes(id)).resolves.toEqual([3, 2, 1]);

        await writer.replace(id, { ...(await read(id)), label: "b" });

        await expect(bytes(id)).resolves.toEqual([3, 2, 1]);
    });
});

describe("insertManyUnsafe stores a v.from column as its parsed output", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("applies the transform, so a later patch of another field leaves it alone", async () => {
        expect.assertions(3);

        const [first, second] = await writer.insertManyUnsafe!("items", [input({ score: "42" }), input({ maybeScore: "7", score: "8" })]);

        await expect(read(first!)).resolves.toMatchObject({ score: 42 });
        await expect(read(second!)).resolves.toMatchObject({ maybeScore: 7, score: 8 });
        await expect(writer.patch(first!, { label: "b" })).resolves.toBeUndefined();
    });

    it("stays unvalidated: only the transform columns are touched", async () => {
        expect.assertions(2);

        // `label` is declared `v.string()`; the unsafe path does not check it.
        const [id] = await writer.insertManyUnsafe!("items", [input({ label: 5 })]);

        await expect(stored(id!, "label")).resolves.toBe(5);
        await expect(stored(id!, "score")).resolves.toBe(42);
    });

    it("a trusted replay keeps the output it already holds", async () => {
        expect.assertions(1);

        const [id] = await writer.insertManyUnsafe!("items", [input({ _id: "r1", score: 42 })], { allowExplicitId: true });

        await expect(stored(id!, "score")).resolves.toBe(42);
    });

    it("leaves a table with no transform column as it was", async () => {
        expect.assertions(1);

        const [id] = await writer.insertManyUnsafe!("plain", [{ label: "x" }]);

        await expect(stored(id!, "label")).resolves.toBe("x");
    });
});

describe("ctx.db writes store the parsed output of a v.from record key", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("insert stores the transformed keys", async () => {
        expect.assertions(1);

        const id = await writer.insert("labelled", { labels: { Alpha: "x", BETA: "y" }, title: "t" });

        await expect(stored(id, "labels")).resolves.toStrictEqual({ alpha: "x", beta: "y" });
    });

    it("patch stores the transformed keys of a record it sets", async () => {
        expect.assertions(1);

        const id = await writer.insert("labelled", { labels: {}, title: "t" });

        await writer.patch(id, { labels: { Gamma: "z" } });

        await expect(stored(id, "labels")).resolves.toStrictEqual({ gamma: "z" });
    });
});

describe("a patch verifier sees the row that will be stored", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("approves a patch whose transform output satisfies the verifier, though the raw input does not", async () => {
        expect.assertions(1);

        const id = await writer.insert("items", input());

        await writer.patch(id, { score: "9" }, undefined, { verify: (_previous, next) => typeof next["score"] === "number" });

        await expect(stored(id, "score")).resolves.toBe(9);
    });

    it("denies a patch whose transform output is forbidden, though the raw input looks fine", async () => {
        expect.assertions(2);

        const id = await writer.insert("items", input());

        await expect(writer.patch(id, { score: "500" }, undefined, { verify: (_previous, next) => next["score"] !== 500 })).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(stored(id, "score")).resolves.toBe(42);
    });
});
