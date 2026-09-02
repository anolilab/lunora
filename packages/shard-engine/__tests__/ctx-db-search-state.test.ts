import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateSearchState, readSearchIndexCoverage, SEARCH_STATE_TABLE, writeSearchBackfillState } from "../src/ctx-db-search-state";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * How this plane spells `searchCoverageSurvives`' answer in SQL — the `MAX(...)`
 * latch against the `excluded.covered` replace, over a real upsert.
 *
 * WHEN the latch may carry, and what it costs when it may not, is decided and
 * argued once in `@lunora/search-core` (`searchCoverageSurvives`) and tested
 * there. These cases exist because the two engines write the flag with different
 * statements, and a shared policy spelled wrong on one plane is still wrong.
 */
describe("search backfill coverage upsert", () => {
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

    it("replaces coverage on the first incomplete page of a rebuild it cannot vouch for", () => {
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

    it("holds a latched 1 against an incomplete page of a rebuild it can vouch for", () => {
        expect.assertions(1);

        // `MAX(covered, excluded.covered)` rather than the replace: the second
        // write carries `done = 0`, and a plain assignment would drop the flag.
        writeSearchBackfillState(database.sql, COMPANION, "doc-1200", true, "en-v1:body");
        writeSearchBackfillState(database.sql, COMPANION, "doc-0500", false, "en-v2:body");

        expect(readSearchIndexCoverage(database.sql, COMPANION)).toBe(true);
    });
});
