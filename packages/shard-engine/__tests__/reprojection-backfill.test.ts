import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { runDataMigration } from "../src/data-migration";
import { encodeDocJson } from "../src/do-sql";
import { buildReprojectionMigration, countLegacyRows, reprojectableFields, reprojectionMigrationId, reprojectionTables } from "../src/reprojection-backfill";
import { serializeSqlValue } from "../src/serialize-sql";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The backfill for rows left unqueryable by the pre-projection storage codec
 * (`reprojection-backfill.ts`).
 *
 * `ctx-db.bigint-bytes.test.ts` pins the defect from the other side — a
 * tagged-in-place row reads correctly, is invisible to `filter`, and heals on
 * any write. This suite pins that the migration performs that healing wholesale
 * without touching rows that do not need it, and without altering a single
 * decoded value on the way through.
 */
const schema: SchemaLike = {
    tables: {
        // Nothing projectable — must never be scanned or migrated.
        auditLog: {
            indexes: [],
            shape: { message: { kind: "string" } },
        },
        // `.global()` rows live in the sql-store backend, which has its own
        // per-column codec and was never affected.
        ledger: {
            indexes: [],
            shape: { totalMinor: { kind: "bigint" } },
            shardMode: { kind: "global" },
        },
        paymentSessions: {
            indexes: [{ fields: ["amountMinor"], name: "by_amount" }],
            shape: {
                amountMinor: { kind: "bigint" },
                currency: { kind: "string" },
                receipt: { kind: "bytes" },
            },
        },
    },
} as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;

const setup = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

/** Insert a row exactly as the pre-projection codec wrote it: `encodeWire` output, tagged array left in place. */
const seedLegacy = (id: string, fields: Record<string, unknown>): void => {
    harness.raw(
        `INSERT INTO paymentSessions (id, _creationTime, "__doc__") VALUES (?, ?, ?)`,
        id,
        1_700_000_000_000,
        JSON.stringify({ _creationTime: 1_700_000_000_000, _id: id, ...fields }),
    );
};

/** Wire-tagged forms as the legacy codec stored them. */
const taggedBigint = (digits: string): unknown[] => ["$lunora.wire$", "bigint", digits];
const taggedBytes = (base64: string): unknown[] => ["$lunora.wire$", "bytes", base64, "ArrayBuffer"];

const storedDoc = (id: string): Record<string, unknown> =>
    JSON.parse(harness.raw(`SELECT "__doc__" FROM paymentSessions WHERE id = ?`, id)[0]?.["__doc__"] as string) as Record<string, unknown>;

const run = async (writer: DatabaseWriterLike, options: { dryRun?: boolean; maxBatches?: number } = {}): Promise<{ changed: number; processed: number }> => {
    const migration = buildReprojectionMigration(reprojectionMigrationId("paymentSessions"), schema, harness.sql);

    if (!migration) {
        throw new Error("expected a migration for paymentSessions");
    }

    // A realistic clock, not `() => 1`: a paused run back-dates `updated_at` to 0
    // to mark itself reclaimable, and the runner's stale-claim check is
    // `updated_at <= now - 30_000`, which no near-zero clock can satisfy.
    const result = await runDataMigration({ batchSize: 2, clock: () => 1_700_000_000_000, migration, sql: harness.sql, writer, ...options });

    return { changed: result.changed, processed: result.processed };
};

describe("reprojection backfill", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("scoping", () => {
        it("selects only tables that can hold an affected row", () => {
            expect.assertions(3);

            // A table with no bigint/bytes column cannot be affected, and a
            // `.global()` table's rows are not in this store at all.
            expect(reprojectionTables(schema)).toStrictEqual(["paymentSessions"]);
            expect(reprojectableFields(schema.tables["auditLog"]!)).toStrictEqual([]);
            expect(reprojectableFields(schema.tables["ledger"]!)).toStrictEqual([]);
        });

        it("has no migration for an unaffected or unknown table", () => {
            expect.assertions(3);

            expect(buildReprojectionMigration(reprojectionMigrationId("auditLog"), schema, harness.sql)).toBeUndefined();
            expect(buildReprojectionMigration(reprojectionMigrationId("ledger"), schema, harness.sql)).toBeUndefined();
            expect(buildReprojectionMigration("backfill-names", schema, harness.sql)).toBeUndefined();
        });
    });

    describe("detection", () => {
        it("counts legacy rows and ignores current-projection ones", async () => {
            expect.assertions(2);

            const writer = setup();

            seedLegacy("legacy-1", { amountMinor: taggedBigint("10"), currency: "usd" });
            await writer.insert("paymentSessions", { _id: "current-1", amountMinor: 10n, currency: "usd" }, { allowExplicitId: true });

            expect(countLegacyRows(harness.sql, "paymentSessions", ["amountMinor", "receipt"])).toBe(1);

            await run(writer);

            // Zero afterwards is the completeness check an operator can run.
            expect(countLegacyRows(harness.sql, "paymentSessions", ["amountMinor", "receipt"])).toBe(0);
        });

        it("does not match a row whose only tagged value is nested", async () => {
            expect.assertions(1);

            // A nested bigint stays wire-tagged under the CURRENT projection —
            // SQL never addresses it. A detector that matched the sentinel
            // anywhere in the blob would rewrite the whole table forever.
            const writer = setup();

            await writer.insert("paymentSessions", { _id: "nested-1", currency: "usd", meta: { fee: 5n } }, { allowExplicitId: true });

            expect(countLegacyRows(harness.sql, "paymentSessions", ["amountMinor", "receipt"])).toBe(0);
        });
    });

    describe("migrating", () => {
        it("makes a legacy row queryable and stores the current projection", async () => {
            expect.assertions(3);

            const writer = setup();

            seedLegacy("legacy-1", { amountMinor: taggedBigint("10"), currency: "usd" });

            const before = await writer.findMany("paymentSessions", { where: { amountMinor: 10n } });

            expect(before.page).toStrictEqual([]);

            await run(writer);

            const after = await writer.findMany("paymentSessions", { where: { amountMinor: 10n } });

            expect(after.page.map((row) => row["_id"])).toStrictEqual(["legacy-1"]);
            expect(storedDoc("legacy-1")["amountMinor"]).toBe(serializeSqlValue(10n));
        });

        it("re-projects a v.bytes() column too", async () => {
            expect.assertions(2);

            const writer = setup();
            const payload = new Uint8Array([1, 2, 3, 255]);

            seedLegacy("legacy-b", { currency: "usd", receipt: taggedBytes("AQID/w==") });

            await run(writer);

            const row = await writer.get("legacy-b", "paymentSessions");

            expect(new Uint8Array(row?.["receipt"] as ArrayBuffer)).toStrictEqual(payload);
            expect(storedDoc("legacy-b")["receipt"]).toBe(serializeSqlValue(payload.buffer));
        });

        it("leaves a row already in the current projection untouched", async () => {
            expect.assertions(3);

            const writer = setup();

            await writer.insert("paymentSessions", { _id: "current-1", amountMinor: 10n, currency: "usd" }, { allowExplicitId: true });
            await writer.insert("paymentSessions", { _id: "current-2", amountMinor: 20n, currency: "usd" }, { allowExplicitId: true });

            const stored = storedDoc("current-1");
            const { changed, processed } = await run(writer);

            expect(processed).toBe(2);
            // Rewriting these is wasted work AND pokes every subscriber on the row.
            expect(changed).toBe(0);
            expect(storedDoc("current-1")).toStrictEqual(stored);
        });

        it("converges a mixed table, rewriting only the legacy half", async () => {
            expect.assertions(3);

            const writer = setup();

            seedLegacy("legacy-1", { amountMinor: taggedBigint("10"), currency: "usd" });
            seedLegacy("legacy-2", { amountMinor: taggedBigint("200"), currency: "eur" });
            await writer.insert("paymentSessions", { _id: "current-1", amountMinor: 30n, currency: "usd" }, { allowExplicitId: true });

            const { changed, processed } = await run(writer);

            expect(processed).toBe(3);
            expect(changed).toBe(2);

            const ordered = await writer.findMany("paymentSessions", { orderBy: [{ amountMinor: "asc" }] });

            expect(ordered.page.map((row) => row["amountMinor"])).toStrictEqual([10n, 30n, 200n]);
        });

        it("counts without rewriting under dryRun", async () => {
            expect.assertions(2);

            const writer = setup();

            seedLegacy("legacy-1", { amountMinor: taggedBigint("10"), currency: "usd" });

            const { changed } = await run(writer, { dryRun: true });

            expect(changed).toBe(1);
            expect(countLegacyRows(harness.sql, "paymentSessions", ["amountMinor", "receipt"])).toBe(1);
        });

        it("does not double-count across a resumed run", async () => {
            expect.assertions(3);

            const writer = setup();

            for (const index of [1, 2, 3, 4, 5]) {
                seedLegacy(`legacy-${String(index)}`, { amountMinor: taggedBigint(String(index)), currency: "usd" });
            }

            // batchSize 2 + maxBatches 1 stops mid-table, leaving the run resumable.
            const first = await run(writer, { maxBatches: 1 });

            expect(first.processed).toBe(2);

            const second = await run(writer);

            // 5 total, not 7 — the resume picks up from the stored cursor rather
            // than rescanning the rows the first invocation already rewrote.
            expect(second.processed).toBe(5);
            expect(second.changed).toBe(5);
        });

        it("is a no-op on a second full run", async () => {
            expect.assertions(1);

            const writer = setup();

            seedLegacy("legacy-1", { amountMinor: taggedBigint("10"), currency: "usd" });

            await run(writer);

            // Completed migrations are idempotent in the runner, so this returns
            // the recorded counts without touching a row.
            expect(countLegacyRows(harness.sql, "paymentSessions", ["amountMinor", "receipt"])).toBe(0);
        });
    });

    describe("value preservation", () => {
        it("leaves every decoded value identical, including the shapes that are easy to lose", async () => {
            expect.assertions(2);

            // The transform is an identity re-encode, so this must hold for the
            // awkward leaves too — a difference here is data loss, not churn.
            // `free` is a v.any()-shaped field, which is where these reach the
            // store in practice.
            const writer = setup();
            const free = {
                date: new Date(5),
                gap: [1, undefined, 3],
                inf: Number.POSITIVE_INFINITY,
                map: new Map([["k", 1n]]),
                nan: Number.NaN,
                nested: { deep: { fee: 9_007_199_254_740_993n } },
                set: new Set([1, 2]),
            };

            // Seed through the LEGACY writer shape: the same wire encoding, with
            // the top-level bigint/bytes left tagged in place.
            harness.raw(
                `INSERT INTO paymentSessions (id, _creationTime, "__doc__") VALUES (?, ?, ?)`,
                "legacy-rich",
                1_700_000_000_000,
                JSON.stringify({
                    ...(JSON.parse(encodeDocJson({ free })) as Record<string, unknown>),
                    _creationTime: 1_700_000_000_000,
                    _id: "legacy-rich",
                    amountMinor: taggedBigint("42"),
                    receipt: taggedBytes("AQI="),
                }),
            );

            const before = await writer.get("legacy-rich", "paymentSessions");

            await run(writer);

            const after = await writer.get("legacy-rich", "paymentSessions");

            expect(after).toStrictEqual(before);
            // …and the projected columns really did move to the queryable form.
            expect(storedDoc("legacy-rich")["amountMinor"]).toBe(serializeSqlValue(42n));
        });
    });
});
