import { isLunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { encodeDocJson } from "../src/do-sql";
import { estimateBytes } from "../src/estimate-bytes";
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
        // `externalId` stands in for the OTHER reason people reach for
        // `v.bigint()` — a snowflake / epoch-nanos id, past 2^53, uniquely
        // indexed and never summed. It carries no aggregate index precisely
        // because summing ids is not a question anyone asks.
        paymentSessions: {
            aggregateIndexes: [
                { by: ["currency"], field: "amountMinor", name: "sumByCurrency", on: "paymentSessions", op: "sum" },
                { by: ["currency"], field: "amountMinor", name: "maxByCurrency", on: "paymentSessions", op: "max" },
            ],
            indexes: [
                { fields: ["amountMinor"], name: "by_amount" },
                { fields: ["currency", "amountMinor"], name: "by_currency_amount" },
                { fields: ["externalId"], name: "by_external", unique: true },
            ],
            shape: {
                amountMinor: { kind: "bigint" },
                capturedMinor: { kind: "bigint" },
                currency: { kind: "string" },
                externalId: { kind: "bigint" },
                // Declared `optional`, projected like a bigint. Every guard that
                // read `validator.kind` directly was blind to exactly this.
                feeMinor: { _meta: { inner: { kind: "bigint" } }, kind: "optional" },
                receipt: { kind: "bytes" },
                refundedMinor: { kind: "bigint" },
            },
        },
        // An UNDECLARED column: `v.any()` commits to no type, so nothing in the
        // schema says "bigint" — but the projection keys off the RUNTIME type,
        // so a `bigint` written here is stored as the same order-preserving key
        // a declared column gets. A guard reading only the declared kind lets
        // the scan reduce those keys and hand back 2e+39.
        ledger: {
            indexes: [],
            shape: { amount: { kind: "any" }, tenant: { kind: "string" } },
        },
        // Soft delete lives on its own table so the aggregate cases above are
        // read through one path only. It no longer forces them onto the scan —
        // a soft-delete table reaches the companion for a projected field — but
        // mixing the two concerns in one fixture would still make a failure
        // ambiguous about which path served it.
        receipts: {
            indexes: [],
            shape: { archivedAt: { kind: "number" }, payload: { kind: "bytes" } },
            softDeleteMode: { field: "archivedAt" },
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

/**
 * The literal on-disk projection for a bigint. Spelled out rather than taken
 * from `serializeSqlValue`: comparing the stored text against the same function
 * that produced it passes even if the projection reverts to `String(value)`,
 * which is precisely the defect this suite exists to prevent recurring.
 */
const BIGINT_KEY = (digits: string): string => `1${digits.padStart(39, "0")}`;

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

            // The one value `Number()` cannot hold: `Number(9007199254740993n)`
            // is 9007199254740992. Storage must be exact regardless.
            const writer = setup();
            const huge = 9_007_199_254_740_993n;

            await writer.insert("paymentSessions", { _id: "a1", currency: "usd", externalId: huge }, { allowExplicitId: true });

            const row = await writer.get("a1");

            expect(row?.["externalId"]).toBe(huge);
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
            // `{"amountMinor":"10"}` — 20 characters. A bigint charged as `{}`
            // (the pre-fix shape) would be 17, and `undefined` fails the insert.
            // A projected bigint is stored TWICE — the 40-char key plus the tagged
            // original — so the estimate has to cover both, not just the digits.
            expect(estimateBytes({ amountMinor: 10n })).toBe(100);
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

        it("never matches a row that is not equal, above 2^53", async () => {
            expect.assertions(3);

            // The rule every other behaviour is subordinate to: an equality
            // predicate must not return a row that is not equal. Three adjacent
            // values straddling 2^53 all collapse onto 9007199254740992 under
            // `Number()`, so a projection built on it returned two extra rows
            // for each probe — false positives out of a `where` that is
            // routinely an authorization filter.
            const writer = setup();
            const values = [9_007_199_254_740_991n, 9_007_199_254_740_992n, 9_007_199_254_740_993n];

            for (const [index, value] of values.entries()) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seed order
                await writer.insert("paymentSessions", { _id: `x${String(index)}`, currency: "usd", externalId: value }, { allowExplicitId: true });
            }

            for (const [index, value] of values.entries()) {
                // eslint-disable-next-line no-await-in-loop -- one probe per seeded value
                const { page } = await writer.findMany("paymentSessions", { where: { externalId: value } });

                expect(ids(page)).toStrictEqual([`x${String(index)}`]);
            }
        });

        it("treats two distinct large bigints as distinct in a unique index", async () => {
            expect.assertions(2);

            // The index is built over `json_extract`, so it indexes whatever the
            // projection stored. A lossy projection collapsed these two ids onto
            // one key and the second insert threw ConflictError — a hard write
            // regression claiming "duplicate" about two different values.
            const writer = setup();

            await writer.insert("paymentSessions", { _id: "u1", currency: "usd", externalId: 1_234_567_890_123_456_789n }, { allowExplicitId: true });
            await writer.insert("paymentSessions", { _id: "u2", currency: "usd", externalId: 1_234_567_890_123_456_790n }, { allowExplicitId: true });

            const { page } = await writer.findMany("paymentSessions", { where: { externalId: 1_234_567_890_123_456_790n } });

            const kept = await writer.get("u1");

            expect(ids(page)).toStrictEqual(["u2"]);
            expect(kept?.["externalId"]).toBe(1_234_567_890_123_456_789n);
        });

        it("pages through a bigint ordering with a real continueCursor", async () => {
            expect.assertions(3);

            // `.paginate()` mints a cursor from the ordered document values, and
            // the encoder was a bare `JSON.stringify` — a real bigint in there
            // threw `TypeError: Do not know how to serialize a BigInt`, so the
            // primary list API was unusable on the column this plan exists for.
            // The seek predicate then compares the decoded cursor value, which
            // only lands on the right row if it re-serializes to the stored key.
            const writer = setup();

            await seed(writer);

            const first = await writer.query("paymentSessions").withIndex("by_amount").paginate({ numItems: 2 });

            expect(first.page.map((row) => row["amountMinor"])).toStrictEqual([9n, 10n]);

            const second = await writer.query("paymentSessions").withIndex("by_amount").paginate({ cursor: first.continueCursor, numItems: 2 });

            expect(second.page.map((row) => row["amountMinor"])).toStrictEqual([200n]);
            expect(second.isDone).toBe(true);
        });

        it("honours a limit alongside a bigint ordering", async () => {
            expect.assertions(1);

            const writer = setup();

            await seed(writer);

            const { page } = await writer.findMany("paymentSessions", { limit: 2, orderBy: [{ amountMinor: "desc" }] });

            expect(page.map((row) => row["amountMinor"])).toStrictEqual([200n, 10n]);
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

        it("recomputes a max group's extreme from the values, not the padded keys", async () => {
            expect.assertions(2);

            // Deleting the row that holds the stored extreme is the one branch
            // that recomputes the group from the source table — on the WRITE
            // path, where the reader's `assertReducibleBySql` refusal cannot
            // apply because refusing would break `delete`. `MAX(json_extract(…))`
            // reads the order-preserving KEY and SQLite coerces that padded text
            // to a REAL, so this stored 1e+39 as the new maximum and every later
            // read returned it.
            const writer = setup();

            await seed(writer);

            await expect(writer.aggregate("paymentSessions", { field: "amountMinor", op: "max", where: { currency: "usd" } })).resolves.toBe(10);

            await writer.delete("s10", "paymentSessions");

            await expect(writer.aggregate("paymentSessions", { field: "amountMinor", op: "max", where: { currency: "usd" } })).resolves.toBe(9);
        });

        it("refuses to reduce an OPTIONAL bigint column too", async () => {
            expect.assertions(2);

            // `v.optional(v.bigint())` has `kind === "optional"` with the real
            // validator on `_meta.inner`. A guard reading `kind` directly let
            // this through and the scan reduced the padded keys: two rows of
            // 100n and 250n summed to 2e+39, silently.
            const writer = setup();

            await writer.insert("paymentSessions", { _id: "o1", currency: "usd", feeMinor: 100n }, { allowExplicitId: true });
            await writer.insert("paymentSessions", { _id: "o2", currency: "usd", feeMinor: 250n }, { allowExplicitId: true });

            const error = await writer.aggregate("paymentSessions", { field: "feeMinor", op: "sum" }).catch((error_: unknown) => error_);

            expect(isLunoraError(error)).toBe(true);
            expect((error as Error).message).toContain("aggregateIndex");
        });

        it("filters an optional bigint column by value", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "o1", currency: "usd", feeMinor: 100n }, { allowExplicitId: true });
            await writer.insert("paymentSessions", { _id: "o2", currency: "usd", feeMinor: 250n }, { allowExplicitId: true });

            const { page } = await writer.findMany("paymentSessions", { where: { feeMinor: 250n } });

            expect(ids(page)).toStrictEqual(["o2"]);
        });

        it("refuses to reduce a bigint column on the SQL scan path", async () => {
            expect.assertions(2);

            // No matching companion group, so the reader falls back to
            // SUM/MAX over `json_extract` — which reads the order-preserving
            // KEY, not the number. Coercing that text gives 1.5e40 for a handful
            // of small values, and MAX hands back the padded string. Both are
            // plausible-looking and wrong, so the reader names the limitation
            // instead. Pre-fix this returned 0 and a raw tagged string.
            const writer = setup();

            await seed(writer);

            const error = await writer.aggregate("paymentSessions", { field: "capturedMinor", op: "sum" }).catch((error_: unknown) => error_);

            expect(isLunoraError(error)).toBe(true);
            expect((error as Error).message).toContain("aggregateIndex");
        });

        it("refuses to aggregate a bigint too large for the companion to hold exactly", async () => {
            expect.assertions(2);

            // `__value__` is a REAL column. Folding a rounded value into a
            // running total produces a sum nobody can audit, so the write that
            // would corrupt the companion fails instead. Pre-fix this surfaced
            // as an unmapped RangeError, i.e. a redacted 500.
            const writer = setup();
            const error = await writer
                .insert("paymentSessions", { amountMinor: 9_007_199_254_740_993n, currency: "usd" }, {})
                .catch((error_: unknown) => error_);

            expect(isLunoraError(error)).toBe(true);
            expect((error as Error).message).toContain("MAX_SAFE_INTEGER");
        });

        it("groups by a bigint column instead of throwing out of the key encoder", async () => {
            expect.assertions(2);

            // Named for `groupBy` and previously asserting `count`, which is why
            // it never noticed that the indexed group key came back as the raw
            // tagged array and the scan path returned the 40-char padded key.
            const writer = setup();

            await seed(writer);

            const grouped = await writer.groupBy("paymentSessions", { agg: { op: "count" }, by: ["currency"] });
            const usd = grouped.find((group) => group["key"]["currency"] === "usd");

            expect(usd?.["value"]).toBe(2);

            // Grouping BY the bigint column itself: the scan cannot hand back a
            // sort key as if it were the value, so it names the limitation.
            const error = await writer.groupBy("paymentSessions", { agg: { op: "count" }, by: ["amountMinor"] }).catch((error_: unknown) => error_);

            expect(isLunoraError(error)).toBe(true);
        });
    });

    describe("undeclared columns that hold a bigint", () => {
        /**
         * `v.any()` / `v.union()` / `v.from()` declare no type, so a `bigint`
         * written into one is projected to its order-preserving key exactly as a
         * `v.bigint()` column is — the projection dispatches on the runtime type.
         * A read-side guard that keys off the DECLARED kind therefore lets the
         * scan reduce those keys: `sum` of 10n + 32n came back as `2e+39`, `max`
         * as the 40-character padded string, and `groupBy` keyed on the padding.
         * All three look like answers, which is what makes it a money bug.
         *
         * The write side has used the wide `mayHoldProjectedValue` test since a
         * declared-kind gate wrote ~1e39 into a companion; this is the read side
         * catching up.
         */
        const seedLedger = async (writer: DatabaseWriterLike): Promise<void> => {
            await writer.insert("ledger", { _id: "l1", amount: 10n, tenant: "t1" }, { allowExplicitId: true });
            await writer.insert("ledger", { _id: "l2", amount: 32n, tenant: "t1" }, { allowExplicitId: true });
        };

        it("still round-trips the value through findMany", async () => {
            expect.assertions(1);

            const writer = setup();

            await seedLedger(writer);

            const { page } = await writer.findMany("ledger", {});

            expect(page.map((row) => row["amount"])).toStrictEqual([10n, 32n]);
        });

        it("refuses to reduce it rather than summing the padded keys", async () => {
            expect.assertions(4);

            const writer = setup();

            await seedLedger(writer);

            for (const op of ["sum", "max"] as const) {
                // eslint-disable-next-line no-await-in-loop -- two ops against one seeded table, sequential by design
                const error = await writer.aggregate("ledger", { field: "amount", op }).catch((error_: unknown) => error_);

                expect(isLunoraError(error)).toBe(true);
                expect((error as Error).message).toContain("aggregateIndex");
            }
        });

        it("refuses it as a groupBy reducer field and as a group key", async () => {
            expect.assertions(4);

            const writer = setup();

            await seedLedger(writer);

            const reducerError = await writer.groupBy("ledger", { agg: { field: "amount", op: "sum" }, by: ["tenant"] }).catch((error_: unknown) => error_);

            expect(isLunoraError(reducerError)).toBe(true);
            expect((reducerError as Error).message).toContain("aggregateIndex");

            const keyError = await writer.groupBy("ledger", { agg: { op: "count" }, by: ["amount"] }).catch((error_: unknown) => error_);

            expect(isLunoraError(keyError)).toBe(true);
            expect((keyError as Error).message).toContain("aggregateIndex");
        });

        it("still reduces an undeclared column that holds plain numbers", async () => {
            expect.assertions(1);

            // The refusal is per-column, not per-value — an `any` column is
            // refused whether or not this particular table holds a bigint today.
            // `count()` hands SQL no field at all, so it keeps working.
            const writer = setup();

            await seedLedger(writer);

            await expect(writer.count("ledger")).resolves.toBe(2);
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

            await writer.insert("receipts", { _id: "a1", payload: new Uint8Array([42, 42]).buffer }, { allowExplicitId: true });
            await writer.delete("a1", "receipts");

            const row = await writer.get("a1", "receipts");

            expect(new Uint8Array(row?.["payload"] as ArrayBuffer)).toStrictEqual(new Uint8Array([42, 42]));
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
            expect.assertions(3);

            // One function now produces both sides (`sql-projection.ts`), so
            // this pins the wiring rather than an agreement between twins: what
            // `encodeDocJson` writes at `$.field` is what `serializeSqlValue`
            // binds against it, for each kind the projection handles.
            const { buffer } = new Uint8Array([1, 2, 3]);
            const view = new Uint8Array(buffer, 1, 2);
            const stored = JSON.parse(encodeDocJson({ amountMinor: 10n, capturedMinor: view, receipt: buffer })) as Record<string, unknown>;

            expect(stored["amountMinor"]).toStrictEqual(BIGINT_KEY("10"));
            expect(stored["receipt"]).toBe("AQID");
            expect(stored["capturedMinor"]).toBe("AgM=");
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

        it("refuses a document carrying the reserved key rather than eating it", () => {
            expect.assertions(4);

            // Nothing stops a schema from declaring a `__originals__` field: the only
            // reserved-name enforcement in the stack is `RESERVED_TABLE_NAMES`
            // in `packages/codegen/src/discover/schema.ts:64`, which covers
            // TABLE names, and `SYSTEM_INDEX_FIELDS`
            // (`packages/server/src/schema.ts:861`), which is a two-entry list
            // of indexable system fields, not a prohibition on user ones.
            //
            // Left unguarded this loses data twice over, silently and on write:
            // a projected document has its field overwritten by the originals
            // map, and one with nothing to project still decodes as though the
            // key were ours — spreading the user's own object up to the top
            // level and dropping the field.
            for (const document of [
                { __originals__: { keep: "me" }, currency: "a" },
                { __originals__: { keep: "me" }, amountMinor: 10n },
            ]) {
                const error = ((): unknown => {
                    try {
                        return encodeDocJson(document);
                    } catch (error_: unknown) {
                        return error_;
                    }
                })();

                expect(isLunoraError(error)).toBe(true);
                expect((error as Error).message).toContain("__originals__");
            }
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

        it("leaves a tagged-in-place row unqueryable until a write re-projects it", async () => {
            expect.assertions(3);

            // Pins the migration answer for rows written while `bigint`s were
            // stored tagged in place: they READ correctly, but the stored text
            // at `$.amountMinor` is still an array, so every `json_extract`
            // comparison misses them. Any write through the store rewrites the
            // whole document and re-projects it — but a row nobody touches stays
            // invisible to `filter`/`withIndex`/`ORDER BY`/`SUM`, so existing
            // data needs a rewrite pass, not just this fix.
            const writer = setup();

            harness.raw(
                "INSERT INTO paymentSessions (id, _creationTime, __doc__) VALUES (?, ?, ?)",
                "tagged-1",
                1_700_000_000_000,
                JSON.stringify({ _creationTime: 1_700_000_000_000, _id: "tagged-1", amountMinor: ["$lunora.wire$", "bigint", "10"], currency: "usd" }),
            );

            const before = await writer.findMany("paymentSessions", { where: { amountMinor: 10n } });

            expect(ids(before.page)).toStrictEqual([]);

            // A single-field patch is enough: `patch` merges over the DECODED
            // document and re-encodes the whole blob.
            await writer.patch("tagged-1", { currency: "eur" });

            const after = await writer.findMany("paymentSessions", { where: { amountMinor: 10n } });
            const stored = JSON.parse(harness.raw(`SELECT __doc__ FROM paymentSessions WHERE id = 'tagged-1'`)[0]?.["__doc__"] as string) as Record<
                string,
                unknown
            >;

            expect(ids(after.page)).toStrictEqual(["tagged-1"]);
            expect(stored["amountMinor"]).toBe(BIGINT_KEY("10"));
        });
    });
});
