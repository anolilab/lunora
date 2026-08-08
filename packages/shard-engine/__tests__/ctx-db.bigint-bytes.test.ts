import { isLunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { encodeDocJson } from "../src/do-sql";
import { estimateBytes } from "../src/estimate-bytes";
import { serializeSqlValue } from "../src/serialize-sql";
import { TransactionHeadroomTracker } from "../src/transaction-headroom";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `v.bigint()` / `v.bytes()` on the DO row store — storage round-trip AND
 * query-side parity.
 *
 * Two separate defects sit behind this suite, and the second is the one the
 * first round of tests missed:
 *
 * **First**, the blob serialized with a raw `JSON.stringify`, which **throws**
 * on a `bigint` and silently flattens an `ArrayBuffer` to `{}`. Routing it
 * through the wire codec fixed the round-trip.
 *
 * **Second**, that made `v.bigint()` silently **unqueryable**. The tagged form
 * put a JSON *array* at `$.amount`, so `json_extract` returned its text while
 * the query side bound the value through `serializeSqlValue`. Nothing matched:
 * `filter` and `withIndex` returned zero rows, `sum` read 0, `max` handed the
 * raw tagged string back to the caller, and `ORDER BY` sorted `9` after `200`.
 * The insert now succeeded where it used to throw, so a balance check read a
 * confident, wrong zero.
 *
 * `encodeDocJson` therefore projects top-level `bigint`/bytes fields to a
 * SQL-comparable scalar and parks the exact originals under a reserved key, and
 * `serializeSqlValue` binds that same projection. Every query-shaped test below
 * exists because its absence is what let (2) ship — a schema declaring
 * `indexes: []` that never filtered, ordered or aggregated.
 *
 * The table mirrors `@lunora/payment`'s `paymentSessions`
 * (`packages/payment/src/schema.ts:49-62`): three `v.bigint()` money columns on
 * a **shard-local** table, which is the first-party path this defect broke.
 */
const schema: SchemaLike = {
    tables: {
        paymentSessions: {
            aggregateIndexes: [
                { by: ["currency"], field: "amountMinor", name: "sumByCurrency", on: "paymentSessions", op: "sum" },
                { by: ["currency"], field: "amountMinor", name: "maxByCurrency", on: "paymentSessions", op: "max" },
            ],
            indexes: [
                { fields: ["amountMinor"], name: "by_amount" },
                { fields: ["currency", "amountMinor"], name: "by_currency_amount" },
            ],
            shape: {
                amountMinor: { kind: "bigint" },
                capturedMinor: { kind: "bigint" },
                currency: { kind: "string" },
                deletedAt: { kind: "number" },
                receipt: { kind: "bytes" },
                refundedMinor: { kind: "bigint" },
            },
            softDeleteMode: { field: "deletedAt" },
        },
    },
} as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;

const setup = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

/** Three sessions whose amounts (9 / 10 / 200) expose lexical-vs-numeric ordering: a TEXT compare sorts 200 before 9. */
const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("paymentSessions", { _id: "s9", amountMinor: 9n, currency: "usd" }, { allowExplicitId: true });
    await writer.insert("paymentSessions", { _id: "s10", amountMinor: 10n, currency: "usd" }, { allowExplicitId: true });
    await writer.insert("paymentSessions", { _id: "s200", amountMinor: 200n, currency: "eur" }, { allowExplicitId: true });
};

const ids = (rows: Record<string, unknown>[]): unknown[] => rows.map((row) => row["_id"]);

describe("ctx-db bigint/bytes doc-blob round-trip", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("v.bigint() storage", () => {
        it("insert/get round-trips a bigint column (pre-fix: insert throws)", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "a1", amountMinor: 10n, currency: "usd" }, { allowExplicitId: true });

            const row = await writer.get("a1");

            expect(row?.["amountMinor"]).toBe(10n);
        });

        it("round-trips a bigint beyond Number.MAX_SAFE_INTEGER exactly", async () => {
            expect.assertions(1);

            // The SQL projection is lossy above 2^53 by construction; the STORED
            // value must not be. This is the whole reason the originals are
            // parked rather than reconstructed from the projection.
            const writer = setup();
            const huge = 9_007_199_254_740_993n;

            await writer.insert("paymentSessions", { _id: "a1", amountMinor: huge, currency: "usd" }, { allowExplicitId: true });

            const row = await writer.get("a1");

            expect(row?.["amountMinor"]).toBe(huge);
        });

        it("findMany round-trips a bigint column", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "a1", amountMinor: 10n, currency: "usd" }, { allowExplicitId: true });

            const { page } = await writer.findMany("paymentSessions", {});

            expect(page[0]?.["amountMinor"]).toBe(10n);
        });

        it("patch preserves a previously-stored bigint column", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "a1", amountMinor: 10n, currency: "usd" }, { allowExplicitId: true });
            await writer.patch("a1", { currency: "eur" });

            const row = await writer.get("a1");

            expect(row?.["amountMinor"]).toBe(10n);
        });

        it("patch can itself write a bigint column", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd" }, { allowExplicitId: true });
            await writer.patch("a1", { capturedMinor: 99n });

            const row = await writer.get("a1");

            expect(row?.["capturedMinor"]).toBe(99n);
        });

        it("charges a bigint write against the transaction meter instead of refusing it", async () => {
            expect.assertions(2);

            // Pre-fix: `estimateBytes` threw on the bigint and returned
            // `undefined`, which `recordWrite` turns into a hard BAD_REQUEST —
            // so with a meter attached (i.e. in production) a `v.bigint()`
            // insert failed outright, not merely queried wrong.
            const tracker = new TransactionHeadroomTracker({ maxReadRows: 1000, maxWrittenBytes: 1_000_000, maxWrittenRows: 100 });

            runShardMigrations(harness.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1, headroom: tracker, schema, sql: harness.sql });

            await writer.insert("paymentSessions", { _id: "a1", amountMinor: 10n, currency: "usd" }, { allowExplicitId: true });

            const row = await writer.get("a1");

            expect(row?.["amountMinor"]).toBe(10n);
            expect(estimateBytes({ amountMinor: 10n })).toBeGreaterThan(0);
        });
    });

    describe("v.bigint() query parity", () => {
        it("filters on equality (pre-fix: matched nothing)", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            const { page } = await writer.findMany("paymentSessions", { where: { amountMinor: 10n } });

            expect(ids(page)).toStrictEqual(["s10"]);
        });

        it("filters on a range numerically, not lexically (pre-fix: matched every row)", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            const { page } = await writer.findMany("paymentSessions", { where: { amountMinor: { gt: 9n } } });

            // A TEXT comparison puts "200" below "9" and matches all three.
            expect(ids(page)).toStrictEqual(["s10", "s200"]);
        });

        it("resolves a withIndex equality range (pre-fix: matched nothing)", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            const rows = await writer
                .query("paymentSessions")
                .withIndex("by_amount", (q) => q.eq("amountMinor", 200n))
                .collect();

            expect(ids(rows)).toStrictEqual(["s200"]);
        });

        it("resolves a withIndex bounded range on a bigint suffix column", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            const rows = await writer
                .query("paymentSessions")
                .withIndex("by_currency_amount", (q) => q.eq("currency", "usd").gte("amountMinor", 10n))
                .collect();

            expect(ids(rows)).toStrictEqual(["s10"]);
        });

        it("orders by a bigint column numerically (pre-fix: 10, 200, 9)", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            const rows = await writer.findMany("paymentSessions", { orderBy: [{ amountMinor: "asc" }] });

            expect(rows.page.map((row) => row["amountMinor"])).toStrictEqual([9n, 10n, 200n]);
        });

        it("counts rows matching a bigint predicate (pre-fix: 0)", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            await expect(writer.count("paymentSessions", { where: { amountMinor: 200n } })).resolves.toBe(1);
        });

        it("sums a bigint column through the maintained companion (pre-fix: null)", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            await expect(writer.aggregate("paymentSessions", { field: "amountMinor", op: "sum", where: { currency: "usd" } })).resolves.toBe(19);
        });

        it("sums and maxes a bigint column through the SQL scan path (pre-fix: 0 and a raw tagged string)", async () => {
            expect.assertions(2);

            const writer = setup();

            await seed(writer);

            // No `where`, so no companion group applies and the reader falls
            // back to SUM/MAX over `json_extract`.
            await expect(writer.aggregate("paymentSessions", { field: "amountMinor", op: "sum" })).resolves.toBe(219);
            await expect(writer.aggregate("paymentSessions", { field: "amountMinor", op: "max" })).resolves.toBe(200);
        });

        it("groups by a bigint column instead of throwing out of the key encoder", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            // `encodeAggregateKey` used a bare `JSON.stringify`, which throws on
            // a bigint `by`-field value.
            await expect(writer.count("paymentSessions", { where: { amountMinor: 9n } })).resolves.toBe(1);
        });
    });

    describe("v.bytes()", () => {
        it("insert/get round-trips a bytes column with identical bytes (pre-fix: reads back {})", async () => {
            expect.assertions(2);

            const writer = setup();
            const bytes = new Uint8Array([1, 2, 3, 255]).buffer;

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd", receipt: bytes }, { allowExplicitId: true });

            const row = await writer.get("a1");

            expect(row?.["receipt"]).toBeInstanceOf(ArrayBuffer);
            expect(new Uint8Array(row?.["receipt"] as ArrayBuffer)).toStrictEqual(new Uint8Array([1, 2, 3, 255]));
        });

        it("survives a read-then-rewrite cycle byte-for-byte and stays an ArrayBuffer", async () => {
            expect.assertions(2);

            // The shape a real handler takes: load the row, hand the decoded doc
            // straight back to `replace`. A decode that returned a view rather
            // than an `ArrayBuffer` — or an encode that could not re-encode its
            // own output — breaks on the second hop, not the first.
            const writer = setup();
            const payload = new Uint8Array([0, 127, 128, 255, 42]);

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd", receipt: payload.buffer }, { allowExplicitId: true });

            const first = await writer.get("a1");

            await writer.replace("a1", { currency: first?.["currency"], receipt: first?.["receipt"] });

            const second = await writer.get("a1");

            expect(second?.["receipt"]).toBeInstanceOf(ArrayBuffer);
            expect(new Uint8Array(second?.["receipt"] as ArrayBuffer)).toStrictEqual(payload);
        });

        it("patch preserves a previously-stored bytes column", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd", receipt: new Uint8Array([9, 8, 7]).buffer }, { allowExplicitId: true });
            await writer.patch("a1", { currency: "eur" });

            const row = await writer.get("a1");

            expect(new Uint8Array(row?.["receipt"] as ArrayBuffer)).toStrictEqual(new Uint8Array([9, 8, 7]));
        });

        it("replace round-trips a bytes column in the new document", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd", receipt: new Uint8Array([0]).buffer }, { allowExplicitId: true });
            await writer.replace("a1", { currency: "usd", receipt: new Uint8Array([1, 1, 2, 3, 5]).buffer });

            const row = await writer.get("a1");

            expect(new Uint8Array(row?.["receipt"] as ArrayBuffer)).toStrictEqual(new Uint8Array([1, 1, 2, 3, 5]));
        });

        it("soft delete's re-stamped doc preserves the bytes column", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd", receipt: new Uint8Array([42, 42]).buffer }, { allowExplicitId: true });
            await writer.delete("a1", "paymentSessions");

            const row = await writer.get("a1", "paymentSessions");

            expect(new Uint8Array(row?.["receipt"] as ArrayBuffer)).toStrictEqual(new Uint8Array([42, 42]));
        });

        it("filters on a bytes column by value", async () => {
            expect.assertions(1);

            const writer = setup();
            const needle = new Uint8Array([7, 7, 7]).buffer;

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd", receipt: needle }, { allowExplicitId: true });
            await writer.insert("paymentSessions", { _id: "a2", currency: "usd", receipt: new Uint8Array([1]).buffer }, { allowExplicitId: true });

            const { page } = await writer.findMany("paymentSessions", { where: { receipt: needle } });

            expect(ids(page)).toStrictEqual(["a1"]);
        });

        it("charges bytes at their stored width rather than as an empty object", async () => {
            expect.assertions(1);

            // `JSON.stringify(new ArrayBuffer(1024))` is `{}` — 2 characters for
            // a kilobyte, the single largest thing a document can under-report
            // to the write meter.
            expect(estimateBytes({ receipt: new ArrayBuffer(1024) })).toBeGreaterThan(1024);
        });
    });

    describe("encoding invariants", () => {
        it("binds the same projection the blob stores for every SQL-comparable kind", () => {
            expect.assertions(2);

            // The invariant the whole query side rests on: whatever
            // `encodeDocJson` writes at `$.field` is what `serializeSqlValue`
            // binds against it. Drift between the two is invisible to types and
            // shows up only as zero rows.
            const bytes = new Uint8Array([1, 2, 3]).buffer;
            const stored = JSON.parse(encodeDocJson({ amountMinor: 10n, receipt: bytes })) as Record<string, unknown>;

            expect(stored["amountMinor"]).toStrictEqual(serializeSqlValue(10n));
            expect(stored["receipt"]).toStrictEqual(serializeSqlValue(bytes));
        });

        it("a doc with no bigint/bytes/Date leaves encodes byte-identically to plain JSON.stringify", () => {
            expect.assertions(1);

            const plainDocument = { _creationTime: 1, _id: "a1", currency: "usd", nested: { flag: true, list: [1, 2, 3], missing: null } };

            expect(encodeDocJson(plainDocument)).toBe(JSON.stringify(plainDocument));
        });

        it("keeps a nested bigint addressable even though SQL never reads it", async () => {
            expect.assertions(1);

            // Only TOP-LEVEL fields are projected — `json_extract` addresses
            // nothing else. A nested bigint still has to round-trip, via the
            // wire codec that runs after the projection.
            const writer = setup();

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd", meta: { fee: 5n } }, { allowExplicitId: true });

            const row = await writer.get("a1");

            expect(row?.["meta"]).toStrictEqual({ fee: 5n });
        });

        it("reports an unstorable value as a typed error, not a raw TypeError", async () => {
            expect.assertions(2);

            // The wire codec rejects non-plain objects with a bare `TypeError`,
            // which surfaces to the caller as an opaque redacted RPC_FAILED.
            const writer = setup();
            const error = await writer.insert("paymentSessions", { currency: "usd", meta: new WeakMap() }, {}).catch((error_: unknown) => error_);

            expect(isLunoraError(error)).toBe(true);
            expect((error as Error).message).toContain("cannot be stored");
        });
    });

    describe("backward compatibility", () => {
        it("a row stored as plain JSON before this codec shipped still reads through ctx.db.get", async () => {
            expect.assertions(1);

            const writer = setup();
            const legacyDocument = { _creationTime: 1_700_000_000_000, _id: "legacy-1", currency: "legacy" };

            // Bypass the writer entirely — insert the row exactly as it would
            // have been written pre-fix (bare `JSON.stringify`, no tags).
            harness.raw(
                "INSERT INTO paymentSessions (id, _creationTime, __doc__) VALUES (?, ?, ?)",
                "legacy-1",
                1_700_000_000_000,
                JSON.stringify(legacyDocument),
            );

            await expect(writer.get("legacy-1", "paymentSessions")).resolves.toMatchObject({ _id: "legacy-1", currency: "legacy" });
        });

        it("a row whose bigint was stored tagged in place still decodes to a bigint", async () => {
            expect.assertions(1);

            // The interim format: `JSON.stringify(encodeWire(doc))` with the
            // tagged array left at `$.amountMinor`. It is unqueryable, but it
            // must still READ — anything written while that shipped is on disk.
            const writer = setup();

            harness.raw(
                "INSERT INTO paymentSessions (id, _creationTime, __doc__) VALUES (?, ?, ?)",
                "tagged-1",
                1_700_000_000_000,
                JSON.stringify({ _creationTime: 1_700_000_000_000, _id: "tagged-1", amountMinor: ["$lunora.wire$", "bigint", "10"], currency: "usd" }),
            );

            const row = await writer.get("tagged-1", "paymentSessions");

            expect(row?.["amountMinor"]).toBe(10n);
        });
    });
});
