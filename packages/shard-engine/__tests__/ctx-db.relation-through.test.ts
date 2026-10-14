import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedThrough, seedWide, THROUGH_CASES, THROUGH_SCHEMA, WIDE_CASES } from "../../../shared/through-cases";
import type { SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { assertShapeShardable } from "../src/relation-predicates";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Many-to-many reads (`with`, `_count`, `some`/`every`/`none`) on a Durable Object's SQLite via `node:sqlite`. The
 * same cases run on a workerd Durable Object (`@lunora/do`) and on D1 (`@lunora/d1`); equal results on all three is
 * the phase gate.
 */
const schema = THROUGH_SCHEMA as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;
const statements: { params: unknown[]; text: string }[] = [];

/** The harness's `SqlExec`, logging each statement so a test can inspect what the engine sent. */
const recordingSql = (): SqlExec => {
    return {
        exec: <Row>(text: string, ...params: unknown[]) => {
            statements.push({ params, text });

            return harness.sql.exec<Row>(text, ...params);
        },
    };
};

const makeWriter = () => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: recordingSql() });
};

describe("many-to-many reads through a join table", () => {
    beforeEach(() => {
        statements.length = 0;
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it.each(THROUGH_CASES)("$name", async ({ expected, run }) => {
        expect.assertions(1);

        const writer = makeWriter();

        await seedThrough(writer);

        await expect(run(writer)).resolves.toStrictEqual(expected);
    });

    it.each(WIDE_CASES)("$name", async ({ expected, run }) => {
        expect.assertions(1);

        const writer = makeWriter();

        await seedThrough(writer);
        await seedWide(writer);

        await expect(run(writer)).resolves.toStrictEqual(expected);
    });

    it("never issues a statement with more than 100 bound parameters or a compound over five terms", async () => {
        expect.assertions(2);

        const writer = makeWriter();

        await seedThrough(writer);
        await seedWide(writer);
        statements.length = 0;

        for (const { run } of [...THROUGH_CASES, ...WIDE_CASES]) {
            // eslint-disable-next-line no-await-in-loop -- sequential so the statement log is attributable
            await run(writer);
        }

        const widest = Math.max(...statements.map(({ params }) => params.length));
        const compound = Math.max(...statements.map(({ text }) => (text.match(/\bUNION\b/gu) ?? []).length + 1));

        expect(widest).toBeLessThanOrEqual(100);
        expect(compound).toBeLessThanOrEqual(5);
    });
});

describe("a live shape whose predicate goes through a join table", () => {
    const withJoin = (join: Record<string, unknown>): SchemaLike => {
        return { tables: { ...THROUGH_SCHEMA.tables, post_tags: { ...THROUGH_SCHEMA.tables.post_tags, ...join } } };
    };
    const predicate = { tags: { some: { label: "red" } } };

    it("is refused even when the owner, the join table and the target all live in one Durable Object", () => {
        expect.assertions(1);

        // The shape's seed and probe read `posts` alone, so a relation predicate would match nothing.
        expect(() => {
            assertShapeShardable(predicate, withJoin({}), "posts");
        }).toThrow(expect.objectContaining({ code: "SHAPE_RELATION_PREDICATE" }));
    });

    it("is accepted on a .global() table, whose shape is read through the store's findMany", () => {
        expect.assertions(1);

        const globalSchema = {
            tables: { ...withJoin({}).tables, posts: { ...THROUGH_SCHEMA.tables.posts, shardMode: { kind: "global" } } },
        } as unknown as SchemaLike;

        expect(() => {
            assertShapeShardable(predicate, globalSchema, "posts");
        }).not.toThrow();
    });

    it("is refused when only the join table is sharded, naming the join table", () => {
        expect.assertions(1);

        expect(() => {
            assertShapeShardable(predicate, withJoin({ shardMode: { field: "postId", kind: "shardBy" } }), "posts");
        }).toThrow(expect.objectContaining({ code: "SHAPE_CROSS_SHARD_JOIN", message: expect.stringContaining('"post_tags"') }));
    });

    it("is refused when only the join table is a memory table, naming the join table", () => {
        expect.assertions(1);

        expect(() => {
            assertShapeShardable(predicate, withJoin({ memoryMode: true }), "posts");
        }).toThrow(expect.objectContaining({ code: "SHAPE_MEMORY_TABLE", message: expect.stringContaining('"post_tags"') }));
    });
});
