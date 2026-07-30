/**
 * The shared `messages` schema fixture for the DO test suites.
 *
 * This file once housed a hand-rolled regex SQL interpreter (`createFakeSql`)
 * that the ctx-db tests ran against. Every suite now executes on the real
 * `node:sqlite` harness (`./node-sqlite`), so only the schema fixture remains —
 * `messages` (sharded) with `by_channel`/`by_channel_creation` indexes and a
 * UNIQUE `by_text`, a `.global()` `profiles`, and `roomMembers`.
 */
import type { SchemaLike } from "@lunora/shard-engine";

const messagesSchema: SchemaLike = {
    tables: {
        messages: {
            indexes: [
                { fields: ["channelId"], name: "by_channel" },
                { fields: ["channelId", "_creationTime"], name: "by_channel_creation" },
                { fields: ["text"], name: "by_text", unique: true },
            ],
            shape: {
                authorId: { kind: "string" },
                channelId: { kind: "string" },
                text: { kind: "string" },
            },
        },
        profiles: {
            indexes: [],
            shape: { userId: { kind: "string" } },
            shardMode: { kind: "global" },
        },
        roomMembers: {
            indexes: [{ fields: ["roomId"], name: "by_room" }],
            shape: { roomId: { kind: "string" }, userId: { kind: "string" } },
        },
    },
};

export default messagesSchema;
