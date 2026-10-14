import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * Many-to-many `{ tags: { some | every: W } }` through a join table — the two-hop semijoin — against the
 * hand-written equivalent a schema without `through` has to spell: `{ postTags: { some: { tag: { is: W } } } }` over
 * a one-to-many into the join table and a to-one out of it. Both resolve to the same two reads; the bench pins that
 * the declaration costs nothing over writing it out, and gives the cost of a `with` load of a joined set.
 *
 * Real `node:sqlite`, JSON-blob dialect, like the other relation benches. 1 000 posts, 200 tags, 6 tags per post
 * (6 000 join rows, 30 per tag).
 *
 * The size is bounded by the join-row cap: a many-to-many hop reads at most 5 000 join rows (the relation key cap) and
 * fails closed past it, rather than materialising a broad join table. `every` reads the rows of the targets
 * that violate the predicate and `some` / `none` those that match it, so a predicate that splits the tags roughly in
 * half needs both halves under the cap: the join table has to stay under twice the cap.
 */
const POST_COUNT = 1000;
const TAG_COUNT = 200;
const TAGS_PER_POST = 6;

const schema: SchemaLike = {
    tables: {
        post_tags: {
            indexes: [
                { fields: ["postId", "tagId"], name: "byPair", unique: true },
                { fields: ["tagId"], name: "byTag" },
            ],
            relationMap: { tag: { field: "tagId", kind: "one", references: "_id", table: "tags" } },
            shape: { postId: { kind: "string" }, tagId: { kind: "string" } },
        },
        posts: {
            indexes: [],
            relationMap: {
                postTags: { field: "postId", kind: "many", references: "_id", table: "post_tags" },
                tags: { kind: "many", table: "tags", through: { from: "postId", table: "post_tags", to: "tagId" } },
            },
            shape: { title: { kind: "string" } },
        },
        tags: { indexes: [], shape: { label: { kind: "string" } } },
    },
};

let writer: DatabaseWriterLike;

beforeAll(async () => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);
    writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

    for (let tag = 0; tag < TAG_COUNT; tag += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
        await writer.insert("tags", { _id: `t${String(tag)}`, label: `tag${String(tag)}` }, { allowExplicitId: true });
    }

    for (let post = 0; post < POST_COUNT; post += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
        await writer.insert("posts", { _id: `p${String(post)}`, title: `post ${String(post)}` }, { allowExplicitId: true });

        for (let link = 0; link < TAGS_PER_POST; link += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("post_tags", { postId: `p${String(post)}`, tagId: `t${String((post + link * 31) % TAG_COUNT)}` }, { allowExplicitId: true });
        }
    }
});

// `contains "1"` matches 119 of the 200 tags (~3 600 join rows), its complement 81 (~2 400): a broad first hop that
// stays under the join-row cap in both directions. `tag7` matches exactly one.
describe("many-to-many `some` — through vs the hand-written two relations", () => {
    bench("through: posts where tags.some(broad label)", async () => {
        await writer.findMany("posts", { limit: 50, where: { tags: { some: { label: { contains: "1" } } } } });
    });

    bench("hand-written: posts where postTags.some(tag.is(broad label))", async () => {
        await writer.findMany("posts", { limit: 50, where: { postTags: { some: { tag: { is: { label: { contains: "1" } } } } } } });
    });

    bench("through: posts where tags.some(one label)", async () => {
        await writer.findMany("posts", { limit: 50, where: { tags: { some: { label: "tag7" } } } });
    });

    bench("hand-written: posts where postTags.some(tag.is(one label))", async () => {
        await writer.findMany("posts", { limit: 50, where: { postTags: { some: { tag: { is: { label: "tag7" } } } } } });
    });
});

describe("many-to-many `every` / `none` / `with` through a join table", () => {
    bench("through: posts where tags.every(broad label)", async () => {
        await writer.findMany("posts", { limit: 50, where: { tags: { every: { label: { contains: "1" } } } } });
    });

    bench("through: posts where tags.none(broad label)", async () => {
        await writer.findMany("posts", { limit: 50, where: { tags: { none: { label: { contains: "1" } } } } });
    });

    bench("through: 50 posts with their tags", async () => {
        await writer.findMany("posts", { limit: 50, with: { tags: true } });
    });

    bench("hand-written: 50 posts with postTags and each tag", async () => {
        await writer.findMany("posts", { limit: 50, with: { postTags: { with: { tag: true } } } });
    });
});
