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

const makeWriter = (maxRelationKeys?: number) => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({
        clock: () => 1_700_000_000_000,
        schema,
        sql: recordingSql(),
        ...(maxRelationKeys === undefined ? {} : { maxRelationKeys }),
    });
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

describe("a many-to-many predicate whose join table holds more rows than the key cap", () => {
    // 300 owners, each linked to all 20 tags, every tag labelled "red": the predicate matches 6 000 join rows but only
    // 300 distinct owners. Join ids sort by owner, so the last 49 owners sit wholly past the first page of 5 001 rows.
    // A walk that stopped after one page would drop them: `some` would under-match and `none` would over-match.
    const OWNERS = 300;
    const TAGS = 20;
    const pad = (value: number): string => String(value).padStart(3, "0");
    const ownerId = (owner: number): string => `p${pad(owner)}`;
    const allOwners = Array.from({ length: OWNERS }, (_, owner) => ownerId(owner));

    const seedWideJoin = async (writer: ReturnType<typeof makeWriter>): Promise<void> => {
        for (let tag = 0; tag < TAGS; tag += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("tags", { _id: `t${pad(tag)}`, label: "red" }, { allowExplicitId: true });
        }

        for (let owner = 0; owner < OWNERS; owner += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("posts", { _id: ownerId(owner), title: `post ${String(owner)}` }, { allowExplicitId: true });

            for (let tag = 0; tag < TAGS; tag += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
                await writer.insert(
                    "post_tags",
                    { _id: `l${pad(owner)}${pad(tag)}`, postId: ownerId(owner), tagId: `t${pad(tag)}` },
                    { allowExplicitId: true },
                );
            }
        }
    };

    /** Ids of the posts a `where` selects, sorted. */
    const selectedOwners = async (writer: ReturnType<typeof makeWriter>, where: Record<string, unknown>): Promise<string[]> => {
        const { page } = await writer.findMany("posts", { where });

        return page.map((row) => String(row["_id"])).toSorted((left, right) => left.localeCompare(right));
    };

    beforeEach(() => {
        statements.length = 0;
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("resolves `some` through every page of join rows, for owners that fit under the cap", async () => {
        expect.assertions(3);

        const writer = makeWriter();

        await seedWideJoin(writer);
        statements.length = 0;

        await expect(selectedOwners(writer, { tags: { some: { label: "red" } } })).resolves.toStrictEqual(allOwners);

        // The walk read the join table in pages of the cap plus one, so it took more than one page to see every owner.
        // A page of the cap plus one row is read as `LIMIT 5002`: one extra row over-fetches to tell the walk a page follows.
        const joinPages = statements.filter(({ text }) => text.includes('FROM "post_tags"') && text.endsWith("LIMIT 5002"));

        expect(joinPages.length).toBeGreaterThanOrEqual(2);
        expect(harness.raw('SELECT COUNT(*) AS n FROM "post_tags"')[0]?.["n"]).toBeGreaterThan(5000);
    }, 60_000);

    it("resolves `none` through every page of join rows, excluding every owner", async () => {
        expect.assertions(1);

        const writer = makeWriter();

        await seedWideJoin(writer);

        await expect(selectedOwners(writer, { tags: { none: { label: "red" } } })).resolves.toStrictEqual([]);
    }, 60_000);

    it("still fails closed when the distinct owners pass the cap", async () => {
        expect.assertions(1);

        // Eleven owners, each linked to the same three red tags: the targets fit under a cap of ten, the owners do not.
        const writer = makeWriter(10);

        for (let tag = 0; tag < 3; tag += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("tags", { _id: `t${pad(tag)}`, label: "red" }, { allowExplicitId: true });
        }

        for (let owner = 0; owner < 11; owner += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("posts", { _id: ownerId(owner), title: `post ${String(owner)}` }, { allowExplicitId: true });

            for (let tag = 0; tag < 3; tag += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
                await writer.insert(
                    "post_tags",
                    { _id: `l${pad(owner)}${pad(tag)}`, postId: ownerId(owner), tagId: `t${pad(tag)}` },
                    { allowExplicitId: true },
                );
            }
        }

        await expect(selectedOwners(writer, { tags: { some: { label: "red" } } })).rejects.toThrow(/exceeding the 10-key limit/u);
    });
});
