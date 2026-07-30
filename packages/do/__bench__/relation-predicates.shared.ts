import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * Shared fixtures for the relation-predicate benches (visulima `__bench__`
 * convention; the strategy comparison lives in one file per relation shape).
 *
 * Real `node:sqlite`, JSON-blob (`json_extract`) dialect — the more pessimistic
 * path, so these numbers bound the D1 column path.
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

/**
 * `contains "1"` matches every user whose index carries a 1 (1, 10–19, 21, …):
 * a broad ~28-user / ~2 800-message set, so the semijoin builds a sizeable `IN`.
 */
export const broadUser = { name: { contains: "1" } } as const;

/**
 * Build a writer pinned to one relation-resolution strategy and seed it (100
 * users, 10k messages, 10k reactions). Production runs `"auto"`; we force
 * `"always"`/`"never"` to measure the two paths the cost policy chooses between.
 *
 * Created — and seeded — INSIDE each file's `beforeAll`, never at module scope:
 * CodSpeed's instrumented runner re-runs the suite, and a module-level shared
 * engine would be seeded twice (the old "unique constraint violation on users").
 * A fresh engine per `beforeAll` invocation always starts clean.
 */
export const makeSeededRelationWriter = async (mode: "always" | "never"): Promise<DatabaseWriterLike> => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);
    const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, relationExistsPushDown: mode, schema, sql: harness.sql });

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

    return writer;
};
