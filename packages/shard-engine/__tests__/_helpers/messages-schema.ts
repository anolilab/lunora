// Test fixture, intentionally duplicated with `@lunora/do`'s copy.
//
// Both packages' suites need it — `@lunora/do` for the shard/socket tests that
// stayed, this package for the `ctx-db` family that moved here. Sharing it would
// mean either exporting a test fixture from a published package's public API, or
// a cross-package relative import that `rootDir` rejects. Neither is worth it for
// a schema literal and a `node:sqlite` factory; if they drift, they drift in the
// direction each suite needs.

/**
 * The shared `messages` schema fixture for the DO test suites.
 *
 * This file once housed a hand-rolled regex SQL interpreter (`createFakeSql`)
 * that the ctx-db tests ran against. Every suite now executes on the real
 * `node:sqlite` harness (`./node-sqlite`), so only the schema fixture remains —
 * `messages` (sharded) with `by_channel`/`by_channel_creation` indexes and a
 * UNIQUE `by_text`, a `.global()` `profiles`, and `roomMembers`.
 */
import type { SchemaLike } from "../../src/schema-types";

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
