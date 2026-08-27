import { describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The implicit `id` tiebreak sorts the same way the key it breaks does.
 *
 * Two things depend on that and they are in different files, which is what made
 * the mismatch survive:
 *
 * Correctness: `buildSeekWhere` (`query-args.ts`) and the ORDER BY builders
 * (`ctx-db.ts`) must agree. A seek that selects `id > cursor` under an `id DESC`
 * ordering walks away from the page it just returned, skipping or repeating rows
 * wherever a page boundary lands inside a group of rows that tie on the real sort
 * key. Ties are not exotic: `_creationTime` has millisecond resolution, so a loop
 * of writes produces them constantly.
 *
 * Performance: declared indexes are built `(<fields>, _creationTime, id)`, all
 * ascending. A single-direction index answers `... DESC, id DESC` by being read
 * backwards, but cannot answer the mixed `... DESC, id ASC` at all; SQLite falls
 * back to `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`.
 */

const schema: SchemaLike = {
    tables: {
        events: {
            indexes: [{ fields: ["room"], name: "by_room" }],
            shape: {
                room: { kind: "string" },
                seq: { kind: "number" },
            },
        },
    },
};

const seeded = async (rows: number) => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);

    // One fixed clock value for every row, so every row ties on `_creationTime`
    // and the tiebreak alone decides the order. This is the case that separates
    // an agreeing seek from a disagreeing one.
    const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

    for (let index = 0; index < rows; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seeding, test setup only
        await writer.insert("events", { room: "r-1", seq: index });
    }

    return { harness, writer };
};

describe("implicit id tiebreak follows the sort direction", () => {
    it("pages a descending read over fully-tied rows without skipping or repeating", async () => {
        expect.assertions(43);

        const { harness, writer } = await seeded(40);

        const seen: string[] = [];
        let cursor: null | string | undefined;

        for (let guard = 0; guard < 20; guard += 1) {
            // eslint-disable-next-line no-await-in-loop -- paging is inherently sequential: each request needs the previous page's cursor
            const page: { continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] } = await writer.findMany("events", {
                cursor,
                limit: 7,
                orderBy: [{ _creationTime: "desc" }],
            });

            for (const row of page.page) {
                expect(typeof row["_id"]).toBe("string");

                seen.push(String(row["_id"]));
            }

            if (page.isDone) {
                break;
            }

            cursor = page.continueCursor;
        }

        harness.close();

        expect(seen).toHaveLength(40);
        expect(new Set(seen).size).toBe(40);
        // Descending overall: with every `_creationTime` equal, the tiebreak is
        // the whole ordering, so the ids must come back strictly descending.
        expect(seen).toStrictEqual(seen.toSorted((left, right) => right.localeCompare(left)));
    });

    it("refuses a cursor minted before the tiebreak changed direction", async () => {
        expect.assertions(4);

        const { harness, writer } = await seeded(6);

        // What a pre-change build handed the client: the raw base64 tuple, with
        // no marker. The BYTES of a cursor never changed — only the direction the
        // seek reads them in — so this is byte-for-byte what was in flight.
        const legacy = btoa(JSON.stringify([1_700_000_000_000, "b"]));

        // Seeking with it used to return rows from the wrong side of the tie
        // group: measured on this exact fixture it produced a row from the
        // PREVIOUS page and made four rows unreachable. Silently, and shaped
        // exactly like a correct page. A typed 400 is recoverable; that is not.
        await expect(writer.findMany("events", { cursor: legacy, limit: 2, orderBy: [{ _creationTime: "desc" }] })).rejects.toThrow(/invalid cursor/iu);

        // The case above rejects even without the marker check, because slicing
        // two characters off unaligned base64 happens to break JSON.parse — an
        // accident, not a guarantee. This one does not: it is a real payload
        // behind a WRONG two-character marker, so dropping the check would slice
        // it cleanly and seek with values it should have refused. It also covers
        // a future marker being handed to this build.
        const wrongMarker = `~9${legacy}`;

        await expect(writer.findMany("events", { cursor: wrongMarker, limit: 2, orderBy: [{ _creationTime: "desc" }] })).rejects.toThrow(/invalid cursor/iu);

        // A cursor this build mints round-trips, and carries the marker that
        // makes the two distinguishable at all.
        const page = await writer.findMany("events", { limit: 2, orderBy: [{ _creationTime: "desc" }] });

        expect(page.continueCursor).toMatch(/^~2/u);

        const next: { page: Record<string, unknown>[] } = await writer.findMany("events", {
            cursor: page.continueCursor,
            limit: 2,
            orderBy: [{ _creationTime: "desc" }],
        });

        expect(next.page).toHaveLength(2);

        harness.close();
    });

    it("keeps the declared index usable for a descending page (no temp b-tree)", async () => {
        expect.assertions(2);

        const { harness } = await seeded(200);

        const plan = (order: string) =>
            harness
                .raw(
                    `EXPLAIN QUERY PLAN SELECT id, _creationTime, "__doc__" FROM "events" WHERE json_extract(__doc__, '$.room') = 'r-1' ORDER BY ${order} LIMIT 21`,
                )
                .map((row) => String(row["detail"]))
                .join(" | ");

        // What the builders emit today.
        expect(plan("_creationTime DESC, id DESC")).not.toContain("TEMP B-TREE");
        // What they emitted before, pinned so a revert is loud rather than slow.
        expect(plan("_creationTime DESC, id ASC")).toContain("TEMP B-TREE");

        harness.close();
    });
});
