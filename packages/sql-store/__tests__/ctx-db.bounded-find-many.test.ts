import { afterEach, describe, expect, it } from "vitest";

import type { OpenTarget } from "../../shard-engine/__tests__/_helpers/bounded-find-many";
import { BOUNDED_FIND_MANY_CASES } from "../../shard-engine/__tests__/_helpers/bounded-find-many";
import openBoundedTarget from "./_helpers/bounded-find-many";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * The bounded (`endCursor`) `findMany` contract on the SQL store, over `node:sqlite`. The workerd
 * twin, against a real D1 binding, is `workerd/bounded-find-many.workerd.test.ts`.
 */
const opened: ReturnType<typeof createSqliteHarness>[] = [];

const open: OpenTarget = async (table) => {
    const harness = createSqliteHarness();

    opened.push(harness);

    return openBoundedTarget(makeSqliteDialect(), harness.exec, table);
};

describe("findMany with endCursor on the SQL store", () => {
    afterEach(() => {
        for (const harness of opened.splice(0)) {
            harness.close();
        }
    });

    it.each(BOUNDED_FIND_MANY_CASES)("%s", async (_title, run) => {
        // Each case states its own `expect.assertions` count.
        expect.hasAssertions();

        await run(open);
    });
});
