import type { SchemaLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedThrough, seedWide, THROUGH_CASES, THROUGH_SCHEMA, WIDE_CASES } from "../../../shared/through-cases";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Many-to-many reads (`with`, `_count`, `some`/`every`/`none`) on the D1 column store. The cases are the ones the
 * Durable Object store runs in `@lunora/shard-engine` and on workerd in `@lunora/do`; equal results on all three is
 * the phase gate. D1 has no EXISTS push-down, so this is the same two-hop semijoin the Durable Object takes.
 */
const FIXED_CLOCK = 1_700_000_000_000;
const schema = THROUGH_SCHEMA as unknown as SchemaLike;

let harness: ReturnType<typeof createD1Exec>;

const setup = () => {
    const meta = `"id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER`;

    harness.ddl(`CREATE TABLE "posts" (${meta}, "title" TEXT)`);
    harness.ddl(`CREATE TABLE "tags" (${meta}, "label" TEXT)`);
    harness.ddl(`CREATE TABLE "post_tags" (${meta}, "postId" TEXT, "tagId" TEXT)`);

    return createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });
};

describe("d1 many-to-many reads through a join table", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it.each(THROUGH_CASES)("$name", async ({ expected, run }) => {
        expect.assertions(1);

        const writer = setup();

        await seedThrough(writer);

        await expect(run(writer)).resolves.toStrictEqual(expected);
    });

    it.each(WIDE_CASES)("$name", async ({ expected, run }) => {
        expect.assertions(1);

        const writer = setup();

        await seedThrough(writer);
        await seedWide(writer);

        await expect(run(writer)).resolves.toStrictEqual(expected);
    });
});
