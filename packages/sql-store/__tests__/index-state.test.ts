import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { indexState } from "../src/sql-exec";
import { createSqliteBatchHarness, makeSqliteDialect } from "./_helpers/sqlite";

let harness: ReturnType<typeof createSqliteBatchHarness>;

describe("indexState on SQLite", () => {
    beforeEach(() => {
        harness = createSqliteBatchHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("reads an index of the same name on another table as absent", async () => {
        expect.assertions(2);

        harness.database.exec(
            `CREATE TABLE "__cdc" ("log_ts" INTEGER); CREATE TABLE "__cdc_log" ("ts" INTEGER); CREATE INDEX "__cdc_log_ts" ON "__cdc" ("log_ts")`,
        );

        const dialect = makeSqliteDialect();

        await expect(indexState(harness.exec, dialect, "__cdc_log", "__cdc_log_ts")).resolves.toBe("absent");
        await expect(indexState(harness.exec, dialect, "__cdc", "__cdc_log_ts")).resolves.toBe("valid");
    });
});
