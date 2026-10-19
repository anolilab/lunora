import { LunoraError } from "@lunora/errors";
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * The SQL store (the `.global()` / D1 backend) must store what the Durable Object
 * backend stores for a `v.from(schema)` column: the schema's OUTPUT, since reads are
 * typed as it. Every other column keeps storing exactly what the caller supplied, and
 * a stored output is never fed back through its transform.
 */
const refuse = (): never => {
    throw new LunoraError("VALIDATION_ERROR", "expected a numeric string");
};

const numericOutput = (value: unknown): number => (typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : refuse());

/** A `v.from` column over a schema that turns a numeric string into a number. */
const fromColumn = (): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind: "from", parse: numericOutput };
};

const optionalFromColumn = (): ValidatorLike => {
    return {
        _meta: { column: { notNull: true }, inner: fromColumn() },
        kind: "optional",
        parse: (value: unknown) => (value === undefined ? undefined : numericOutput(value)),
    };
};

const col = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

/**
 * `v.bytes()` normalises a view to an `ArrayBuffer` when it PARSES; the fake does the same, so
 * a test can tell whether the parsed result was adopted as the stored value.
 */
const bytesColumn = (): ValidatorLike => {
    return {
        _meta: { column: { notNull: true } },
        kind: "bytes",
        parse: (value: unknown) => (value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value),
    };
};

const schema = {
    tables: {
        items: {
            indexes: [],
            shape: {
                balance: col("bigint"),
                blob: bytesColumn(),
                label: col("string"),
                maybeScore: optionalFromColumn(),
                note: { _meta: { column: { notNull: false } }, kind: "string" },
                optionalLabel: {
                    _meta: { column: { notNull: true }, inner: { _meta: { column: { notNull: true } }, kind: "string" } },
                    kind: "optional",
                },
                score: fromColumn(),
            },
            shardMode: { kind: "global" },
        },
    },
} as never as SchemaLike;

let harness: ReturnType<typeof createSqliteHarness>;
let writer: ReturnType<typeof createSqlCtxDb>;

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

const stored = async (id: string, field: string): Promise<unknown> => {
    const row = await read(id);

    return row[field];
};

describe("createSqlCtxDb writes store the parsed output of v.from columns", () => {
    beforeEach(() => {
        harness = createSqliteHarness();
        writer = createSqlCtxDb({ clock: () => 1_700_000_000_000, dialect: makeSqliteDialect(), exec: harness.exec, schema });
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

        const id = await writer.insert("items", input({ _id: "i1", score: 5 }), { allowExplicitId: true });

        await expect(stored(id, "score")).resolves.toBe(5);

        await writer.replace(id, input({ score: 6 }), undefined, { allowExplicitId: true });

        await expect(stored(id, "score")).resolves.toBe(6);

        await expect(writer.insert("items", input({ score: 5 }))).rejects.toThrow(/numeric string/iu);
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
