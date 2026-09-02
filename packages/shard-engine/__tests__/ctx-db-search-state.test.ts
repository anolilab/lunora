import { planSearchBackfillPass } from "@lunora/search-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateSearchState, readSearchBackfillState, readSearchIndexCoverage, SEARCH_STATE_TABLE, writeSearchBackfillState } from "../src/ctx-db-search-state";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The `covered` latch is what lets a REBUILDING companion keep serving while a
 * NEW one refuses, and it survives an analyzer-version bump on purpose. What it
 * must not survive is a rebuild it cannot vouch for.
 *
 * A progress row written before profile tracking existed carries `covered = 1`
 * and no profile. `planSearchBackfillPass` reads "no profile" as a mismatch —
 * it wipes the companion and re-walks from the top — but the latch used to
 * classify the same absence as "unchanged" and hold `covered` at 1 through the
 * wipe. An emptied companion then reported itself complete, and every read until
 * the walk finished returned a fraction of the matches as the whole answer.
 */
describe("search backfill coverage across a legacy progress row", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
        migrateSearchState(database.sql);
    });

    afterEach(() => {
        database.close();
    });

    const COMPANION = "docs__fts_by_body";

    /** A row as an earlier build left it: finished, latched, and with nothing recorded about what analyzed it. */
    const seedLegacyRow = (): void => {
        database.raw(`INSERT INTO "${SEARCH_STATE_TABLE}" ("companion", "cursor", "done", "profile", "covered") VALUES (?, NULL, 1, NULL, 1)`, COMPANION);
    };

    it("plans a wipe-and-rewalk for a row with no recorded profile", () => {
        expect.assertions(1);

        seedLegacyRow();

        // The premise the latch has to answer to: the companion's rows are about
        // to be discarded.
        expect(planSearchBackfillPass(readSearchBackfillState(database.sql, COMPANION), "en-v1:body")).toStrictEqual({
            cursor: undefined,
            finished: false,
            wipe: true,
        });
    });

    it("drops coverage on the first incomplete page of that rewalk", () => {
        expect.assertions(2);

        seedLegacyRow();

        expect(readSearchIndexCoverage(database.sql, COMPANION)).toBe(true);

        writeSearchBackfillState(database.sql, COMPANION, "doc-0500", false, "en-v1:body");

        expect(readSearchIndexCoverage(database.sql, COMPANION)).toBe(false);
    });

    it("re-latches coverage when that rewalk reaches the end of the table", () => {
        expect.assertions(1);

        seedLegacyRow();

        writeSearchBackfillState(database.sql, COMPANION, "doc-0500", false, "en-v1:body");
        writeSearchBackfillState(database.sql, COMPANION, "doc-1200", true, "en-v1:body");

        expect(readSearchIndexCoverage(database.sql, COMPANION)).toBe(true);
    });

    it("still holds the latch through an analyzer bump that keeps the same field", () => {
        expect.assertions(1);

        // The case the latch exists for: the rows are all present, just analyzed
        // by older rules, so refusing every search for the length of the re-walk
        // would be the worse answer.
        writeSearchBackfillState(database.sql, COMPANION, "doc-1200", true, "en-v1:body");
        writeSearchBackfillState(database.sql, COMPANION, "doc-0500", false, "en-v2:body");

        expect(readSearchIndexCoverage(database.sql, COMPANION)).toBe(true);
    });
});
