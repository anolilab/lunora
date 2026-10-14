/**
 * Many-to-many reads (`with`, `_count`, `some`/`every`/`none`) on a real D1 binding.
 *
 * The cases are the ones the Durable Object runs in `@lunora/shard-engine` (node:sqlite) and `@lunora/do` (workerd), so
 * equal results here close the conformance gate for D1. The wide cases carry a 150-id list at each hop, past the 100
 * bound parameters D1 allows a statement: the node harness cannot reach that cap, a real binding can.
 *
 * Each case rebuilds its three tables, because D1 storage is shared across the file.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { seedThrough, seedWide, THROUGH_CASES, THROUGH_SCHEMA, WIDE_CASES } from "../../../../shared/through-cases";
import type { D1Exec } from "../../src/d1-ctx-db";
import { createD1CtxDb } from "../../src/d1-ctx-db";

const schema = THROUGH_SCHEMA as unknown as SchemaLike;

const exec: D1Exec = {
    all: async (query, parameters) => {
        const result = await env.DB.prepare(query)
            .bind(...parameters)
            .all();

        return result.results;
    },
    run: async (query, parameters) => {
        await env.DB.prepare(query)
            .bind(...parameters)
            .run();
    },
};

const meta = `"id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER`;

const freshWriter = async (): Promise<ReturnType<typeof createD1CtxDb>> => {
    for (const statement of [
        `DROP TABLE IF EXISTS "post_tags"`,
        `DROP TABLE IF EXISTS "posts"`,
        `DROP TABLE IF EXISTS "tags"`,
        `CREATE TABLE "posts" (${meta}, "title" TEXT)`,
        `CREATE TABLE "tags" (${meta}, "label" TEXT)`,
        `CREATE TABLE "post_tags" (${meta}, "postId" TEXT, "tagId" TEXT)`,
    ]) {
        // eslint-disable-next-line no-await-in-loop -- DDL in order
        await exec.run(statement, []);
    }

    return createD1CtxDb({ exec, idGenerator: () => crypto.randomUUID(), schema });
};

describe("d1 many-to-many reads on workerd", () => {
    it.each(THROUGH_CASES)("$name", async ({ expected, run }) => {
        expect.assertions(1);

        const writer = await freshWriter();

        await seedThrough(writer);

        await expect(run(writer)).resolves.toStrictEqual(expected);
    });

    it.each(WIDE_CASES)("$name", async ({ expected, run }) => {
        expect.assertions(1);

        const writer = await freshWriter();

        await seedThrough(writer);
        await seedWide(writer);

        await expect(run(writer)).resolves.toStrictEqual(expected);
    });
});
