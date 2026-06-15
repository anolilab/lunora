import type { Schema } from "@cirrus/server";
import type { TestHarness } from "@cirrus/testing";

import type { SeedOptions } from "./plan";
import { seedPlan } from "./plan";

/**
 * Seed an in-memory {@link TestHarness} (`@cirrus/testing`'s `cirrusTest`).
 *
 * Runs {@link seedPlan} and inserts every generated row through `ctx.db.insert`
 * with `allowExplicitId` so the planned `_id`s — and therefore every resolved
 * foreign key — are preserved. Tables are written in FK order (parents first).
 * @returns the inserted document ids keyed by table, for assertions.
 * @example
 * const harness = cirrusTest(schema);
 * const ids = await seed(harness, schema, { counts: { users: 5, posts: 20 } });
 * expect(ids.users).toHaveLength(5);
 */
const seed = async (harness: TestHarness, schema: Schema, options: SeedOptions = {}): Promise<Record<string, string[]>> => {
    const plan = seedPlan(schema, options);
    const ids: Record<string, string[]> = {};

    await harness.run(async (context) => {
        // `allowExplicitId` is the trusted-import path on the DO writer; it is not
        // on the public `DatabaseWriter.insert` type surfaced through the harness,
        // so the option is passed through a narrowed local reference.
        const insert = context.db.insert as (table: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean }) => Promise<string>;

        for (const { rows, table } of plan) {
            const tableIds: string[] = [];

            for (const row of rows) {
                // Sequential by design: parents must land before children so each
                // resolved foreign key references an already-inserted row.
                // eslint-disable-next-line no-await-in-loop -- ordered inserts preserve FK consistency
                tableIds.push(await insert(table, row, { allowExplicitId: true }));
            }

            ids[table] = tableIds;
        }
    });

    return ids;
};

// eslint-disable-next-line import/prefer-default-export -- named export: re-exported by name from `@cirrus/seed/testing`, per the repo's no-default-mixing convention
export { seed };
