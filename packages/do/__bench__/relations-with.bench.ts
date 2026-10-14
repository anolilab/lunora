import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * `findMany({ with: { … } })` joins each result row with a related table.
 * The implementation in `relations.ts` issues one indexed fetch per
 * declared relation per page — not a per-row N+1 — but the cost still
 * scales with the page size + the relation depth.
 *
 * - **no `with`** — baseline; one page read, no joins.
 * - **one one-relation** — `with: { author: true }` joins each message
 * to its author. One extra indexed lookup batched across the page.
 * - **one many-relation** — `with: { reactions: true }` fans each
 * message out to its reactions. Same query shape but the result
 * cardinality blows up.
 * - **deep with** — `with: { author: true, reactions: true }` exercises
 * two relation paths per row.
 *
 * Page size: 50 messages over a population of 500 messages with 2
 * reactions each. Real SQLite — relation logic is dialect-agnostic so
 * the JSON-blob path is the more pessimistic baseline of the two.
 */

const MESSAGE_COUNT = 500;
const REACTIONS_PER_MESSAGE = 2;
const PAGE_SIZE = 50;

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
            shape: { emoji: { kind: "string" }, messageId: { kind: "string" } },
        },
        users: {
            indexes: [],
            shape: { name: { kind: "string" } },
        },
    },
};

const harness = createSqliteExec();

runShardMigrations(harness.sql, schema);

const writer: DatabaseWriterLike = createShardContextDatabase({ schema, sql: harness.sql });

// Seed: 10 users, 500 messages spread across them, 2 reactions per message.
const USER_COUNT = 10;

for (let user = 0; user < USER_COUNT; user += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
    await writer.insert("users", { _id: `u${String(user)}`, name: `User ${String(user)}` });
}

for (let message = 0; message < MESSAGE_COUNT; message += 1) {
    const authorId = `u${String(message % USER_COUNT)}`;

    // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
    await writer.insert("messages", { _id: `m${String(message)}`, authorId, body: `msg ${String(message)}` });

    for (let reaction = 0; reaction < REACTIONS_PER_MESSAGE; reaction += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
        await writer.insert("reactions", {
            _id: `r-m${String(message)}-${String(reaction)}`,
            emoji: "👍",
            messageId: `m${String(message)}`,
        });
    }
}

describe("findMany with: — relation loading per page", () => {
    bench("no with: baseline (50 messages, no joins)", async () => {
        await writer.findMany("messages", { limit: PAGE_SIZE });
    });

    bench("one-relation: with { author: true } (50 msgs × 1 user lookup)", async () => {
        await writer.findMany("messages", { limit: PAGE_SIZE, with: { author: true } });
    });

    bench("many-relation: with { reactions: true } (50 msgs × N reactions each)", async () => {
        await writer.findMany("messages", { limit: PAGE_SIZE, with: { reactions: true } });
    });

    bench("two relations: with { author: true, reactions: true }", async () => {
        await writer.findMany("messages", { limit: PAGE_SIZE, with: { author: true, reactions: true } });
    });
});
