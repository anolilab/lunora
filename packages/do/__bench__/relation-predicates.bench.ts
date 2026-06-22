import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";

/**
 * Relation-crossing `where` predicates (`{ author: { is: W } }`,
 * `{ posts: { some: W } }`, …) have two resolution strategies, and the cost gap
 * between them is the whole point of the Phase 2 push-down.
 *
 * The semijoin strategy (universal) runs a child query, pulls back the matched
 * join keys, and rewrites the parent node to a flat `IN (...)`. One extra
 * round-trip per relation node, and the `IN` list grows with the match set
 * (capped at maxRelationKeys).
 *
 * The correlated EXISTS strategy (same-shard fast path) emits `[NOT] EXISTS
 * (SELECT 1 FROM child …)` inline. One SELECT, no key round-trip, no cap.
 *
 * We bench both over the same large, identically-seeded SQLite so the only
 * variable is the strategy (the push-down toggle flips it).
 *
 * Measured finding (do NOT assume EXISTS is the fast path here): on the
 * in-process JSON-blob dialect the semijoin is markedly faster than the
 * push-down for the common "large parent set, small/indexed child" shape — the
 * semijoin reduces the parent read to an indexed flat `IN (...)` over the FK
 * index, whereas the correlated EXISTS turns the parent read into a scan that
 * re-runs the subquery per row. On real Durable Objects the SQLite is
 * in-process, so the semijoin's extra "round-trip" is cheap and this gap holds.
 * The push-down's real value is therefore escaping the key cap for child sets
 * too large to materialize as an `IN (...)`, not raw latency.
 *
 * This finding is now baked into the production default: `relationExistsPushDown:
 * "auto"` resolves via the semijoin first and only escalates a node to the EXISTS
 * push-down when its child key set overflows the cap — so the common case pays
 * the cheap path and the large case still escapes the cap. These benches force
 * `"always"`/`"never"` to keep both underlying strategies visible and
 * regression-tested; read the summary ratios before assuming push-down is a win.
 *
 * The fourth group pins the no-relation fast path: every `findMany` runs
 * `containsRelationPredicate` over its `where` before deciding to rewrite. On a
 * relation-bearing table with an ordinary flat predicate that scan must be
 * negligible — the common read pays nothing for the feature existing.
 *
 * Real `node:sqlite` — the JSON-blob (`json_extract`) path is the more
 * pessimistic of the two dialects, so these numbers bound the D1 column path.
 */

const USER_COUNT = 100;
const MESSAGES_PER_USER = 100; // 10 000 messages
const MESSAGE_COUNT = USER_COUNT * MESSAGES_PER_USER;

const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["authorId"], name: "by_author" }],
            relationMap: {
                author: { field: "authorId", kind: "one", references: "_id", table: "users" },
                reactions: { field: "messageId", kind: "many", references: "_id", table: "reactions" },
            },
            shape: { authorId: { kind: "string" }, body: { kind: "string" } },
        },
        reactions: {
            indexes: [{ fields: ["messageId"], name: "by_message" }],
            relationMap: {
                message: { field: "messageId", kind: "one", references: "_id", table: "messages" },
            },
            shape: { emoji: { kind: "string" }, messageId: { kind: "string" } },
        },
        users: {
            indexes: [],
            relationMap: {
                messages: { field: "authorId", kind: "many", references: "_id", table: "messages" },
            },
            shape: { name: { kind: "string" } },
        },
    },
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let user = 0; user < USER_COUNT; user += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
        await writer.insert("users", { _id: `u${String(user)}`, name: `User ${String(user)}` }, { allowExplicitId: true });
    }

    for (let message = 0; message < MESSAGE_COUNT; message += 1) {
        const authorId = `u${String(message % USER_COUNT)}`;

        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
        await writer.insert("messages", { _id: `m${String(message)}`, authorId, body: `msg ${String(message)}` }, { allowExplicitId: true });
        // One reaction per message keeps the grandchild table large for the multi-hop bench.
        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
        await writer.insert("reactions", { _id: `r${String(message)}`, emoji: "👍", messageId: `m${String(message)}` }, { allowExplicitId: true });
    }
};

// Two writers over two separate, identically-seeded engines, each pinned to one
// strategy so the bench isolates them. (Production runs `"auto"`, which would
// pick the semijoin for these under-cap sets — we force `"always"`/`"never"`
// here precisely to measure the two paths the cost policy chooses between.)
const pushHarness = createSqliteExec();

runShardMigrations(pushHarness.sql, schema);
const pushWriter = createShardContextDatabase({ clock: () => 1_700_000_000_000, relationExistsPushDown: "always", schema, sql: pushHarness.sql });

const semijoinHarness = createSqliteExec();

runShardMigrations(semijoinHarness.sql, schema);
const semijoinWriter = createShardContextDatabase({ clock: () => 1_700_000_000_000, relationExistsPushDown: "never", schema, sql: semijoinHarness.sql });

// Seed in beforeAll: CodSpeed's instrumented runner (@codspeed/vitest-plugin)
// runs each bench against the suite's beforeAll/beforeEach hooks but does NOT
// pick up module-top-level await state, so a top-level seed leaves the bench
// querying an empty DB. beforeAll is honored in both the plain `vitest bench`
// runner and CodSpeed's analysis runner.
beforeAll(async () => {
    await seed(pushWriter);
    await seed(semijoinWriter);
});

// `contains "1"` matches every user whose index carries a 1 (1, 10–19, 21, …):
// a broad ~28-user / ~2 800-message set, so the semijoin builds a sizeable IN.
const broadUser = { name: { contains: "1" } };

describe("to-one `is` — EXISTS push-down vs semijoin (broad match)", () => {
    bench("push-down: messages where author.is(broad)", async () => {
        await pushWriter.findMany("messages", { limit: 50, where: { author: { is: broadUser } } });
    });

    bench("semijoin: messages where author.is(broad)", async () => {
        await semijoinWriter.findMany("messages", { limit: 50, where: { author: { is: broadUser } } });
    });
});

describe("to-many `some` — EXISTS push-down vs semijoin (broad match)", () => {
    bench("push-down: users where messages.some(broad body)", async () => {
        await pushWriter.findMany("users", { limit: 50, where: { messages: { some: { body: { contains: "1" } } } } });
    });

    bench("semijoin: users where messages.some(broad body)", async () => {
        await semijoinWriter.findMany("users", { limit: 50, where: { messages: { some: { body: { contains: "1" } } } } });
    });
});

describe("multi-hop `reactions → message → author` — push-down vs semijoin", () => {
    bench("push-down: reactions where message.is(author.is(broad))", async () => {
        await pushWriter.findMany("reactions", { limit: 50, where: { message: { is: { author: { is: broadUser } } } } });
    });

    bench("semijoin: reactions where message.is(author.is(broad))", async () => {
        await semijoinWriter.findMany("reactions", { limit: 50, where: { message: { is: { author: { is: broadUser } } } } });
    });
});

describe("no-relation fast path — containsRelationPredicate overhead", () => {
    // A flat predicate on a relation-bearing table: the read must NOT pay for the
    // feature beyond one synchronous `containsRelationPredicate` scan of `where`.
    bench("flat where on a relation-bearing table (no relation predicate)", async () => {
        await pushWriter.findMany("messages", { limit: 50, where: { body: { contains: "99" } } });
    });

    bench("no where at all (pure scan baseline)", async () => {
        await pushWriter.findMany("messages", { limit: 50 });
    });
});
