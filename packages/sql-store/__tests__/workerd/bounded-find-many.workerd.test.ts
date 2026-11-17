/**
 * The bounded (`endCursor`) `findMany` contract on a `.global()` table against a **real** D1
 * binding in workerd, so the inclusive end bound is checked against D1's own SQLite. Each case owns
 * a table name: D1 storage is shared across the tests in this file.
 */
import { describe, expect, it } from "vitest";

import { BOUNDED_FIND_MANY_CASES } from "../../../shard-engine/__tests__/_helpers/bounded-find-many";
import openBoundedTarget from "../_helpers/bounded-find-many";
import { d1Dialect, d1Exec } from "./_helpers/d1";

describe("findMany with endCursor on D1", () => {
    it.each(BOUNDED_FIND_MANY_CASES)("%s", async (_title, run) => {
        // Each case states its own `expect.assertions` count.
        expect.hasAssertions();

        await run(async (table) => openBoundedTarget(d1Dialect, d1Exec, table));
    });
});
