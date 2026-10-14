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

const setup = (maxRelationKeys?: number) => {
    const meta = `"id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER`;

    harness.ddl(`CREATE TABLE "posts" (${meta}, "title" TEXT)`);
    harness.ddl(`CREATE TABLE "tags" (${meta}, "label" TEXT)`);
    harness.ddl(`CREATE TABLE "post_tags" (${meta}, "postId" TEXT, "tagId" TEXT)`);

    return createD1ContextDatabase({
        clock: () => FIXED_CLOCK,
        exec: harness.exec,
        schema,
        ...(maxRelationKeys === undefined ? {} : { maxRelationKeys }),
    });
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

describe("d1 many-to-many predicate walks every page of a join table", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    // A cap of three keeps the walk to pages of four rows. The ids sort the join rows by owner, so p3's only rows
    // fall wholly on the second page: a walk that stopped after one page would drop p3.
    it("resolves `some` and `none` across pages, for owners that fit under the cap", async () => {
        expect.assertions(2);

        const writer = setup(3);

        for (const tag of ["t1", "t2", "t3"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same table
            await writer.insert("tags", { _id: tag, label: "red" }, { allowExplicitId: true });
        }

        const links: [string, string, string][] = [
            ["l1", "p1", "t1"],
            ["l2", "p1", "t2"],
            ["l3", "p1", "t3"],
            ["l4", "p2", "t1"],
            ["l5", "p3", "t1"],
            ["l6", "p3", "t2"],
            ["l7", "p3", "t3"],
        ];

        for (const [id, postId, tagId] of links) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same table
            await writer.insert("post_tags", { _id: id, postId, tagId }, { allowExplicitId: true });
        }

        for (const post of ["p1", "p2", "p3"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same table
            await writer.insert("posts", { _id: post, title: post }, { allowExplicitId: true });
        }

        const owners = async (where: Record<string, unknown>): Promise<string[]> => {
            const { page } = await writer.findMany("posts", { where });

            return page.map((row) => String(row["_id"])).toSorted((left, right) => left.localeCompare(right));
        };

        await expect(owners({ tags: { some: { label: "red" } } })).resolves.toStrictEqual(["p1", "p2", "p3"]);
        await expect(owners({ tags: { none: { label: "red" } } })).resolves.toStrictEqual([]);
    });
});
