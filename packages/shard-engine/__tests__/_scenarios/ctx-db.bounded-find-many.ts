import { afterEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../../src/ctx-db";
import type { OpenTarget } from "../_helpers/bounded-find-many";
import { BOUNDED_FIND_MANY_CASES } from "../_helpers/bounded-find-many";
import type { SqlHarness } from "../_helpers/sql-harness";

/**
 * The bounded-`findMany` contract on the Durable Object store. `score` is optional, so the NULL
 * group the contract pages across is a column the document omits — how a DO row spells NULL.
 */
const schema: SchemaLike = {
    tables: {
        items: {
            indexes: [],
            shape: {
                group: { kind: "string" },
                label: { kind: "string" },
                score: { kind: "optional" },
                seq: { kind: "number" },
            },
        },
    },
};

const opened: SqlHarness[] = [];

const runBoundedFindManyDoScenarios = (factory: () => SqlHarness): void => {
    const open: OpenTarget = async () => {
        const harness = factory();

        opened.push(harness);
        runShardMigrations(harness.sql, schema);

        // One instant for every row, so the order keys tie on `_creationTime` and only the id splits a tie.
        const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

        return {
            findMany: async (args) => writer.findMany("items", args),
            insert: async (document) => writer.insert("items", document),
        };
    };

    describe("findMany with endCursor on the Durable Object store", () => {
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
};

export default runBoundedFindManyDoScenarios;
