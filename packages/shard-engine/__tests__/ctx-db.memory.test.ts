import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations, selectShapeRows } from "../src/ctx-db";
import { cdcCanVouchFor, cdcTouchesTables, readCdcCursor } from "../src/ctx-db-cdc";
import { clearMemoryTables, isMemoryTable, memoryTableNames } from "../src/ctx-db-memory";
import type { ReadFootprint } from "../src/read-footprint";
import { createReadFootprint, UNVOUCHABLE_DEP } from "../src/read-footprint";
import { assertShapeShardable } from "../src/relation-predicates";
import { buildShapeDiff } from "../src/shape-diff";
import { ShapeDiffCache } from "../src/shape-diff-cache";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `.memory()` — the ephemeral tier.
 *
 * Two properties are the ones the feature actually promises: the rows do not
 * survive a shard restart (`clearMemoryTables`, which the generated
 * `runShardInit` calls on every cold start), and the writes never reach the CDC
 * changelog. Everything else about a memory table is deliberately identical to a
 * durable one — same migration, same indexes, same reads — so there is nothing
 * separate to assert about querying it.
 *
 * The rest of this suite pins the CONSEQUENCES of that second property, which
 * two changelog consumers used to get wrong by assuming a local table is always
 * one the log speaks for: a subscription that read a memory table must not be
 * told it can resume, and a shape over one must be refused rather than left to
 * seed once and freeze.
 */
const schema: SchemaLike = {
    tables: {
        // Durable control.
        rooms: {
            indexes: [],
            shape: { name: { kind: "string" } },
        },
        presence: {
            indexes: [{ fields: ["roomId"], name: "by_room" }],
            memoryMode: true,
            shape: { roomId: { kind: "string" }, userId: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const writer = (): DatabaseWriterLike => createShardContextDatabase({ cdc: true, clock: () => 1_700_000_000_000, schema, sql: harness.sql });

/** A writer whose reads are recorded into `footprint` — what `executeSubscription` builds to decide a reconnect's resume verdict. */
const trackedWriter = (footprint: ReadFootprint): DatabaseWriterLike =>
    createShardContextDatabase({
        cdc: true,
        clock: () => 1_700_000_000_000,
        onRead: footprint.onRead,
        onReadRange: footprint.onReadRange,
        schema,
        sql: harness.sql,
    });

/** Row count of `table` through a fresh writer, projected off the await so the lint's await-member rule is satisfied. */
const rowCount = async (database: DatabaseWriterLike, table: string, where?: Record<string, unknown>): Promise<number> => {
    const result = await database.findMany(table, where === undefined ? {} : { where });

    return result.page.length;
};

/** The tables named in the changelog, in `seq` order. Projected to strings: `node:sqlite` rows have a null prototype, which no object matcher compares cleanly against a literal. */
const cdcTables = (): string[] =>
    harness.sql
        .exec('SELECT "table" AS t FROM __cdc_log ORDER BY seq')
        .toArray()
        .map((row) => String((row as { t: unknown }).t));

describe("ctx-db memory tables", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema, { cdc: true });
    });

    afterEach(() => {
        harness.close();
    });

    it("identifies memory tables from the schema", () => {
        expect.assertions(3);

        expect(isMemoryTable(schema.tables["presence"])).toBe(true);
        expect(isMemoryTable(schema.tables["rooms"])).toBe(false);
        expect(memoryTableNames(schema)).toStrictEqual(["presence"]);
    });

    it("migrates a memory table like any other, so reads work unchanged", async () => {
        expect.assertions(2);

        const database = writer();

        await database.insert("presence", { roomId: "r1", userId: "u1" });
        await database.insert("presence", { roomId: "r2", userId: "u2" });

        // The declared index is a plain SQLite index and answers normally.
        const inRoom = await database.findMany("presence", { where: { roomId: "r1" } });

        expect(inRoom.page).toHaveLength(1);
        expect(inRoom.page[0]?.["userId"]).toBe("u1");
    });

    it("keeps memory writes out of the CDC changelog while durable writes land", async () => {
        expect.assertions(1);

        const database = writer();

        await database.insert("rooms", { name: "general" });
        await database.insert("presence", { roomId: "r1", userId: "u1" });
        await database.insert("presence", { roomId: "r1", userId: "u2" });

        // Only the durable insert is in the log. This is not a size optimisation:
        // log retention is opt-in, so on a default deployment a heartbeat-rate
        // presence table would grow it for the life of the shard, and a CDC
        // consumer replaying it would materialize state the shard itself drops
        // on the next eviction.
        expect(cdcTables()).toStrictEqual(["rooms"]);
    });

    it("clears memory tables and leaves durable ones untouched", async () => {
        expect.assertions(4);

        const seed = writer();

        await seed.insert("rooms", { name: "general" });
        await seed.insert("presence", { roomId: "r1", userId: "u1" });

        await expect(rowCount(seed, "presence")).resolves.toBe(1);

        // What `runShardInit` does on every cold start.
        expect(clearMemoryTables(harness.sql, schema)).toBe(1);

        const after = writer();

        await expect(rowCount(after, "presence")).resolves.toBe(0);
        await expect(rowCount(after, "rooms")).resolves.toBe(1);
    });

    /**
     * A subscription that read a memory table must never be told it can resume.
     *
     * `cdcCanVouchFor` reads the vouchable set out of `sqlite_master`, and a
     * memory table is in there — migrations create it, only its rows are cleared
     * — while `recordCdc` never appends a single entry for it. So the changelog
     * answered "nothing changed" for a table it has no record of, and a client
     * that cached a roster, disconnected while presence churned, and reconnected
     * got `resumable: true` with no snapshot: it kept the pre-disconnect roster
     * for the life of the subscription.
     *
     * Run at a scale where the staleness is unmistakable — the client's cached
     * answer is 40 rows and the truth has moved to 120.
     */
    it("marks a subscription that read a memory table un-resumable", async () => {
        expect.assertions(6);

        const seed = writer();

        for (let index = 0; index < 40; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding: each insert advances the shared changelog cursor the assertions below read
            await seed.insert("presence", { roomId: "r1", userId: `u${String(index)}` });
        }

        // What the reconnecting client cached, and the cursor it cached it at.
        const footprint = createReadFootprint();
        const cached = await trackedWriter(footprint).findMany("presence", { where: { roomId: "r1" } });
        const sinceSeq = readCdcCursor(harness.sql);

        expect(cached.page).toHaveLength(40);

        // The roster churns hard while the client is away.
        const churn = writer();

        for (let index = 40; index < 120; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential churn: the point is that none of it reaches the changelog
            await churn.insert("presence", { roomId: "r1", userId: `u${String(index)}` });
        }

        // The changelog is exactly as it was: not one of the 80 writes landed.
        expect(readCdcCursor(harness.sql)).toBe(sinceSeq);
        expect(cdcTouchesTables(harness.sql, sinceSeq, footprint.tables)).toBe(false);

        // So the verdict must NOT be "resumable": the log cannot speak for this
        // read-set at all.
        expect(cdcCanVouchFor(harness.sql, footprint.tables)).toBe(false);

        // The read-set still names the table itself, so the LIVE refresh path —
        // driven by the changed-table set, not the log — is untouched.
        expect(footprint.tables.has("presence")).toBe(true);

        // …and it also carries the sentinel, which no table in `sqlite_master`
        // can ever match, which is what puts the verdict in the default branch.
        expect(footprint.tables.has(UNVOUCHABLE_DEP)).toBe(true);
    });

    it("still vouches for a subscription that read only durable tables", async () => {
        expect.assertions(2);

        const footprint = createReadFootprint();

        await trackedWriter(footprint).findMany("rooms", {});

        // The stamp is scoped to memory tables: a durable read stays resumable,
        // or every reconnect in every app would re-snapshot.
        expect(footprint.tables.has(UNVOUCHABLE_DEP)).toBe(false);
        expect(cdcCanVouchFor(harness.sql, footprint.tables)).toBe(true);
    });

    /**
     * A shape over a memory table is refused at registration.
     *
     * A shard-local shape replicates FROM `__cdc_log`, which never records a
     * memory table — so `buildShapeDiff` returns `[]` on every flush before it
     * even probes membership, and the shape seeds once and then never moves
     * again, with no error and no counter to say so. The second half of this test
     * pins that underlying behaviour, so the refusal above is anchored to the
     * defect it prevents rather than to a rule someone can delete as arbitrary.
     */
    it("refuses a shape over a memory table, because its diff can never move", async () => {
        expect.assertions(5);

        const seed = writer();

        await seed.insert("presence", { _id: "p1", roomId: "r1", userId: "u1" }, { allowExplicitId: true });

        const seedCursor = readCdcCursor(harness.sql);

        expect(selectShapeRows(harness.sql, "presence", { roomId: "r1" }).map((row) => row.id)).toStrictEqual(["p1"]);

        await seed.insert("presence", { _id: "p2", roomId: "r1", userId: "u2" }, { allowExplicitId: true });

        // Server truth moved; the changelog did not, so the diff the poke path
        // would send is empty. This is what the guard exists to prevent.
        expect(
            buildShapeDiff(harness.sql, { effectiveWhere: { roomId: "r1" }, table: "presence" }, seedCursor, readCdcCursor(harness.sql), new ShapeDiffCache()),
        ).toStrictEqual([]);
        expect(selectShapeRows(harness.sql, "presence", { roomId: "r1" }).map((row) => row.id)).toStrictEqual(["p1", "p2"]);

        expect(() => {
            assertShapeShardable({ roomId: "r1" }, schema, "presence");
        }).toThrow(expect.objectContaining({ code: "SHAPE_MEMORY_TABLE" }));
        // A shape on the durable control table is untouched by the new branch.
        expect(() => {
            assertShapeShardable({ name: "general" }, schema, "rooms");
        }).not.toThrow();
    });

    it("refuses a shape on a DURABLE table whose predicate joins a memory table", () => {
        expect.assertions(2);

        // The sibling of the case above, one join away: the shape's own table is
        // durable and logged, so every check on it passes — but membership turns
        // on `presence`, whose writes never reach the changelog, so the diff can
        // never move for a room that empties or fills.
        const joined: SchemaLike = {
            tables: {
                ...schema.tables,
                rooms: {
                    ...schema.tables["rooms"]!,
                    relationMap: { presence: { field: "roomId", kind: "many", references: "_id", table: "presence" } },
                },
            },
        };

        expect(() => {
            assertShapeShardable({ presence: { some: { userId: "u1" } } }, joined, "rooms");
        }).toThrow(expect.objectContaining({ code: "SHAPE_MEMORY_TABLE" }));

        // A predicate over the durable table's own columns still passes.
        expect(() => {
            assertShapeShardable({ name: "general" }, joined, "rooms");
        }).not.toThrow();
    });

    it("leaves the table usable after a clear", async () => {
        expect.assertions(1);

        const seed = writer();

        await seed.insert("presence", { roomId: "r1", userId: "u1" });
        clearMemoryTables(harness.sql, schema);

        // `DELETE FROM`, not `DROP` — the table and its index survive, which is
        // what lets an `onShardInit` hook refill it immediately.
        const rebuilt = writer();

        await rebuilt.insert("presence", { roomId: "r1", userId: "u2" });

        await expect(rowCount(rebuilt, "presence", { roomId: "r1" })).resolves.toBe(1);
    });
});
