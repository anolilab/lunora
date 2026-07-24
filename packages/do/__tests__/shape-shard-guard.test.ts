import { assertShapeShardable } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";

/**
 * Registration-time guard for partial-replication shapes. A live shape pokes
 * only from its OWN shard Durable Object, so an `effectiveWhere` that joins to a
 * `.shardBy()` table (rows that live in another DO) is rejected the moment the
 * generated `resolveShape` compiles it. A join to a `root` (same DO) or
 * `.global()` (D1) table is allowed.
 */

// `messages` is sharded by room; `members` is sharded by tenant (a DIFFERENT DO);
// `flags` is a root table (same DO); `countries` is a `.global()` D1 table.
const schema = {
    tables: {
        countries: {
            indexes: [],
            relationMap: {},
            shape: { name: { kind: "string" } },
            shardMode: { kind: "global" },
        },
        flags: {
            indexes: [],
            relationMap: {},
            shape: { value: { kind: "string" } },
            shardMode: { kind: "root" },
        },
        members: {
            indexes: [],
            relationMap: {},
            shape: { tenantId: { kind: "string" } },
            shardMode: { field: "tenantId", kind: "shardBy" },
        },
        messages: {
            indexes: [],
            relationMap: {
                author: { field: "authorId", kind: "one", references: "_id", table: "members" },
                country: { field: "countryId", kind: "one", references: "_id", table: "countries" },
                flag: { field: "flagId", kind: "one", references: "_id", table: "flags" },
            },
            shape: { roomId: { kind: "string" } },
            shardMode: { field: "roomId", kind: "shardBy" },
        },
    },
} as unknown as SchemaLike;

/** Capture the error a call throws (or `undefined`), so assertions stay outside any catch. */
const thrownBy = (run: () => void): unknown => {
    try {
        run();

        return undefined;
    } catch (error) {
        return error;
    }
};

describe("assertShapeShardable", () => {
    it("allows a flat, relation-free predicate", () => {
        expect.assertions(1);

        expect(
            thrownBy(() => {
                assertShapeShardable({ roomId: "r1" }, schema, "messages");
            }),
        ).toBeUndefined();
    });

    it("allows a join to a root (same-DO) table", () => {
        expect.assertions(1);

        expect(
            thrownBy(() => {
                assertShapeShardable({ flag: { is: { value: "on" } } }, schema, "messages");
            }),
        ).toBeUndefined();
    });

    it("allows a join to a .global() (D1) table", () => {
        expect.assertions(1);

        expect(
            thrownBy(() => {
                assertShapeShardable({ country: { is: { name: "DE" } } }, schema, "messages");
            }),
        ).toBeUndefined();
    });

    it("rejects a join to another .shardBy() table with a SHAPE_CROSS_SHARD_JOIN error", () => {
        expect.assertions(3);

        const error = thrownBy(() => {
            assertShapeShardable({ author: { is: { tenantId: "t1" } } }, schema, "messages");
        });

        expect((error as { code?: string }).code).toBe("SHAPE_CROSS_SHARD_JOIN");
        expect((error as Error).message).toContain('"members"');
        // The two documented remedies are surfaced to the developer.
        expect((error as Error).message).toContain(".global()");
    });

    it("rejects a sharded join nested under a boolean branch", () => {
        expect.assertions(1);

        const error = thrownBy(() => {
            assertShapeShardable({ AND: [{ roomId: "r1" }, { OR: [{ author: { some: { tenantId: "t2" } } }] }] }, schema, "messages");
        });

        expect((error as { code?: string }).code).toBe("SHAPE_CROSS_SHARD_JOIN");
    });

    it("is a no-op when there is no effectiveWhere", () => {
        expect.assertions(1);

        expect(
            thrownBy(() => {
                assertShapeShardable(undefined, schema, "messages");
            }),
        ).toBeUndefined();
    });
});
