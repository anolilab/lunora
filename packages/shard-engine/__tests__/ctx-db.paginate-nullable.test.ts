import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Keyset pagination over a NULLABLE ordered column, against a real SQLite
 * engine — the only place the defect shows, because it lives in how the seek
 * predicate and the `ORDER BY` place NULLs relative to each other.
 *
 * Two spellings of "no value" reach the cursor, and both used to break paging.
 * An explicit `null` compiled the seek's `{ gt: null }` down to `col IS NULL`,
 * which matched every null row instead of none — page 2's predicate was subsumed
 * by its own first disjunct, so it returned page 1 again forever and every
 * non-null row was unreachable. An ABSENT field (a `v.optional()` column the
 * document omits) put a literal `undefined` in the cursor, which the compiler
 * bound verbatim to SQLite.
 *
 * The fixture keeps two rows in the null group and three outside it, paged two
 * at a time, so a page boundary lands INSIDE the null group and another crosses
 * out of it. A smaller fixture never reaches either failure.
 */
const scoresSchema: SchemaLike = {
    tables: {
        entries: {
            indexes: [],
            shape: {
                label: { kind: "string" },
                // `optional`, so a document may omit the column outright — the
                // other spelling of "no value" this file pages across.
                score: { kind: "optional" },
            },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, scoresSchema);

    return createShardContextDatabase({
        clock: () => 1_700_000_000_000,
        schema: scoresSchema,
        sql: harness.sql,
    });
};

const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((document_) => document_["_id"]);

/** Walk every page of a `findMany` cursor sort, returning the ids in visit order. Bounded so a non-advancing cursor fails as a wrong list rather than hanging. */
const walkPages = async (writer: DatabaseWriterLike, direction: "asc" | "desc"): Promise<unknown[]> => {
    const visited: unknown[] = [];
    let cursor: null | string | undefined;

    for (let page = 0; page < 6; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- paging is inherently sequential: each page needs the previous page's cursor.
        const result = await writer.findMany("entries", { cursor, limit: 2, orderBy: [{ score: direction }] });

        visited.push(...ids(result.page));

        if (result.isDone || result.continueCursor === null) {
            break;
        }

        cursor = result.continueCursor;
    }

    return visited;
};

describe("ctx-db paginate — nullable ordered column", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("explicit null in the ordered column", () => {
        /** Two null-scored rows then three scored ones, so `numItems: 2` splits the null group AND crosses out of it. */
        const seedNulls = async (writer: DatabaseWriterLike): Promise<void> => {
            await writer.insert("entries", { _id: "n1", label: "n1", score: null }, { allowExplicitId: true });

            await writer.insert("entries", { _id: "n2", label: "n2", score: null }, { allowExplicitId: true });
            await writer.insert("entries", { _id: "s1", label: "s1", score: 10 }, { allowExplicitId: true });
            await writer.insert("entries", { _id: "s2", label: "s2", score: 20 }, { allowExplicitId: true });
            await writer.insert("entries", { _id: "s3", label: "s3", score: 30 }, { allowExplicitId: true });
        };

        it("ascending: pages past the null group instead of re-serving it", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await seedNulls(writer);

            // SQLite sorts NULLs FIRST ascending, and the id tiebreak follows the
            // key's direction, so the total order is n1, n2, s1, s2, s3.
            await expect(walkPages(writer, "asc")).resolves.toEqual(["n1", "n2", "s1", "s2", "s3"]);

            // The failure the walk above hides if it ever regresses to returning a
            // prefix: the page STARTING at the null-group boundary must move on.
            const first = await writer.findMany("entries", { limit: 2, orderBy: [{ score: "asc" }] });
            const second = await writer.findMany("entries", { cursor: first.continueCursor, limit: 2, orderBy: [{ score: "asc" }] });

            expect(ids(second.page)).toEqual(["s1", "s2"]);
        });

        it("descending: reaches the null group that sorts last", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await seedNulls(writer);

            // NULLs sort LAST descending, so they are the rows the seek has to
            // reach AFTER the scored ones — a bare `score < ?` never matches them.
            await expect(walkPages(writer, "desc")).resolves.toEqual(["s3", "s2", "s1", "n2", "n1"]);
        });
    });

    describe("field absent from the document", () => {
        /** The same shape, spelled by OMITTING the optional column rather than storing null. */
        const seedAbsent = async (writer: DatabaseWriterLike): Promise<void> => {
            await writer.insert("entries", { _id: "n1", label: "n1" }, { allowExplicitId: true });
            await writer.insert("entries", { _id: "n2", label: "n2" }, { allowExplicitId: true });
            await writer.insert("entries", { _id: "s1", label: "s1", score: 10 }, { allowExplicitId: true });
            await writer.insert("entries", { _id: "s2", label: "s2", score: 20 }, { allowExplicitId: true });
            await writer.insert("entries", { _id: "s3", label: "s3", score: 30 }, { allowExplicitId: true });
        };

        it("ascending: an absent column pages exactly like an explicit null", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await seedAbsent(writer);

            // `json_extract` of a missing key IS NULL, so the ordering is the same —
            // but the cursor carries `undefined`, not `null`, and binding that
            // verbatim is a driver error rather than a wrong answer.
            await expect(walkPages(writer, "asc")).resolves.toEqual(["n1", "n2", "s1", "s2", "s3"]);
        });

        it("descending: an absent column reaches the trailing null group", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await seedAbsent(writer);

            await expect(walkPages(writer, "desc")).resolves.toEqual(["s3", "s2", "s1", "n2", "n1"]);
        });
    });
});
