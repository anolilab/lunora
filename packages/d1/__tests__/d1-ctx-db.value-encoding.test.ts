import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * End-to-end value encoding on the `.global()` plane: what a document holds on
 * the way in is what `get`/`findMany` hand back on the way out.
 *
 * Every case here went in as one JS value and came out as another — a number as
 * the text `"1.0"`, an explicitly written `null` as a missing field, a user
 * string as the number it happened to spell. Each ran against a real SQLite
 * engine through the auto-provisioned table, because all three defects live in
 * the seam between the column TYPE the schema picks and the codec pair the read
 * runs, and neither half is wrong on its own.
 */

const literalCol = (value: bigint | boolean | null | number | string): ValidatorLike => {
    return { _meta: { column: { notNull: true }, value }, kind: "literal" };
};

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

/** `v.optional(inner)` as `@lunora/values` builds it: the wrapper is itself NOT NULL, the inner carries the real kind. */
const optionalCol = (inner: ValidatorLike): ValidatorLike => {
    return { _meta: { column: { notNull: true }, inner }, kind: "optional" };
};

/** `v.string().nullable()` — `.nullable()` is the one modifier that clears `notNull`. */
const nullableCol = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: false } }, kind };
};

/** `v.union(...members)` as `@lunora/values` builds it: the members live on `_meta.members`. */
const unionCol = (...members: ValidatorLike[]): ValidatorLike => {
    return { _meta: { column: { notNull: true }, members }, kind: "union" };
};

const schema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            shape: {
                litBigint: literalCol(7n),
                litBoolean: literalCol(true),
                litNumber: literalCol(1),
                litString: literalCol("x"),
                optAny: optionalCol(col("any")),
                optNullLiteral: optionalCol(literalCol(null)),
                optNullableString: optionalCol(nullableCol("string")),
                optString: optionalCol(col("string")),
                optStringOrNull: optionalCol(unionCol(col("string"), col("null"))),
                untyped: col("any"),
            },
            shardMode: { kind: "global" },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

/** A ctx-db over the current harness, with ids counted from this call so a test can insert more than once. */
const openDb = (): DatabaseWriterLike => {
    let nextId = 0;

    return createD1CtxDb({
        clock: () => 1_700_000_000_000,
        exec: harness.exec,
        idGenerator: () => {
            nextId += 1;

            return `d${String(nextId)}`;
        },
        schema,
    });
};

/** Insert a document, filling the required literal columns with their one legal value. */
const roundTrip = async (db: DatabaseWriterLike, document: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = await db.insert("docs", { litBigint: 7n, litBoolean: true, litNumber: 1, litString: "x", untyped: "ok", ...document });
    const read = await db.get(id);

    if (read === null) {
        throw new Error("row not found");
    }

    return read;
};

describe("d1 ctx-db value encoding", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("a v.literal() column round-trips its payload's JS type", () => {
        it('returns the number 1, not the text "1.0"', async () => {
            expect.assertions(1);

            // A literal used to answer `"literal"` for its storage kind, which
            // is no kind at all: the column was provisioned TEXT, SQLite's TEXT
            // affinity rewrote the bound `1` as `"1.0"`, and the decode had
            // nothing to reverse it with. The row was written, read back wrong,
            // and then unpatchable — `expected literal 1, received "1.0"`.
            const read = await roundTrip(openDb(), {});

            expect(read["litNumber"]).toBe(1);
        });

        it('returns true, not the text "1.0"', async () => {
            expect.assertions(1);

            // The same defect one type over: `sqliteEncode` maps a boolean to
            // 1/0 (SQLite has no boolean), and TEXT affinity then made that
            // `"1.0"` too.
            const read = await roundTrip(openDb(), {});

            expect(read["litBoolean"]).toBe(true);
        });

        it("returns 7n, not 40 characters of sort key", async () => {
            expect.assertions(1);

            // A bigint literal was stored as the order-preserving key a declared
            // `v.bigint()` gets — correct on the way in, never decoded on the
            // way out.
            const read = await roundTrip(openDb(), {});

            expect(read["litBigint"]).toBe(7n);
        });

        it("still returns a string literal verbatim", async () => {
            expect.assertions(1);

            const read = await roundTrip(openDb(), {});

            expect(read["litString"]).toBe("x");
        });

        it("provisions each literal column with its payload's affinity", async () => {
            expect.assertions(4);

            await roundTrip(openDb(), {});

            const columns = await harness.exec.all(`PRAGMA table_info("docs")`, []);
            const typeOf = (name: string): unknown => columns.find((column) => column["name"] === name)?.["type"];

            expect(typeOf("litNumber")).toBe("REAL");
            expect(typeOf("litBoolean")).toBe("INTEGER");
            expect(typeOf("litBigint")).toBe("TEXT");
            expect(typeOf("litString")).toBe("TEXT");
        });
    });

    describe("an explicit null survives on a column whose type admits null", () => {
        it("keeps a null written to v.optional(v.any())", async () => {
            expect.assertions(2);

            // `v.any()` accepts `null`, so a stored NULL there is a value the
            // caller wrote, not a field they left unset. Reading it as ABSENT
            // discarded it — and the DO plane, which keeps documents as JSON,
            // kept it.
            const read = await roundTrip(openDb(), { optAny: null });

            expect("optAny" in read).toBe(true);
            expect(read["optAny"]).toBeNull();
        });

        it("keeps a null written to v.optional(v.union(v.string(), v.null()))", async () => {
            expect.assertions(2);

            const read = await roundTrip(openDb(), { optStringOrNull: null });

            expect("optStringOrNull" in read).toBe(true);
            expect(read["optStringOrNull"]).toBeNull();
        });

        it("keeps a null written to v.optional(v.literal(null))", async () => {
            expect.assertions(1);

            const read = await roundTrip(openDb(), { optNullLiteral: null });

            expect("optNullLiteral" in read).toBe(true);
        });

        it("keeps a null written to v.optional(v.string().nullable())", async () => {
            expect.assertions(1);

            // The case that already worked — `.nullable()` clears `notNull`, the
            // one signal the old test read. Pinned so widening the test does not
            // regress it.

            const read = await roundTrip(openDb(), { optNullableString: null });

            expect(read["optNullableString"]).toBeNull();
        });

        it("still reads an unset v.optional(v.string()) as ABSENT, not null", async () => {
            expect.assertions(1);

            // `v.optional(v.string())` is `string | undefined` — never `null`.
            // Decoding its NULL as `null` is a lie about the declared type and
            // breaks the export/import round trip outright, because the importer
            // runs `optional(string).parse(null)` and that throws.
            const read = await roundTrip(openDb(), {});

            expect("optString" in read).toBe(false);
        });
    });

    describe("a user string that merely looks like a wire payload", () => {
        it("returns the string it was given, not the payload it resembles", async () => {
            expect.assertions(2);

            const db = openDb();
            const withText = await roundTrip(db, { untyped: "$lunora.wire$hello" });
            const withNumber = await roundTrip(db, { untyped: "$lunora.wire$42" });

            expect(withText["untyped"]).toBe("$lunora.wire$hello");
            // The sharper half: a string column handing back a NUMBER.
            expect(withNumber["untyped"]).toBe("$lunora.wire$42");
        });

        it("still matches that string in a where filter", async () => {
            expect.assertions(1);

            // The escape is written by the column-aware encode, and every WHERE
            // binding goes through the same one — so an escaped row is still
            // found by the value the caller wrote. A kind-blind escape would
            // have made the row unfindable.
            const db = openDb();

            await roundTrip(db, { untyped: "$lunora.wire$hello" });

            const page = await db.findMany("docs", { where: { untyped: "$lunora.wire$hello" } });

            expect(page.page).toHaveLength(1);
        });
    });
});
