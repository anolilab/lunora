/**
 * Many-to-many reads (`with`, `_count`, `some`/`every`/`none`) on a real Durable Object's SQLite.
 *
 * The cases are the ones the node:sqlite run in `@lunora/shard-engine` and the D1 run in `@lunora/d1` use, so equal
 * results here close the conformance gate. The wide cases also pin what `node:sqlite` cannot: workerd caps a
 * statement at 100 bound parameters, so a predicate whose first hop matches 150 tags must send its id list as one
 * parameter rather than one per id.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { seedThrough, seedWide, THROUGH_CASES, THROUGH_SCHEMA, WIDE_CASES } from "../../../../shared/through-cases";

const schema = THROUGH_SCHEMA as unknown as SchemaLike;

describe("many-to-many reads on workerd", () => {
    it.each([
        ...THROUGH_CASES.map((entry) => {
            return { ...entry, wide: false };
        }),
        ...WIDE_CASES.map((entry) => {
            return { ...entry, wide: true };
        }),
    ])("$name", async ({ expected, name, run, wide }) => {
        expect.assertions(1);

        const stub = env.SHARD.get(env.SHARD.idFromName(`through-${name}`));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = { exec: state.storage.sql.exec.bind(state.storage.sql) } as never;

            runShardMigrations(sql, schema);

            const db = createShardCtxDb({ schema, sql });

            await seedThrough(db);

            if (wide) {
                await seedWide(db);
            }

            await expect(run(db)).resolves.toStrictEqual(expected);
        });
    });
});
