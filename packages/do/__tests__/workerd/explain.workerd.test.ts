/**
 * `ctx.db.<table>.explain` on real workerd SQLite.
 *
 * `explain` runs `EXPLAIN QUERY PLAN` against the statement a read compiles to. Whether a Durable
 * Object's `storage.sql` accepts that statement at all, and what it reports, is a property of
 * workerd's SQLite build, which `node:sqlite` cannot answer.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const schema = {
    tables: {
        messages: {
            indexes: [{ fields: ["room"], name: "by_room" }],
            shape: { body: { kind: "string" }, room: { kind: "string" } },
        },
    },
} as unknown as SchemaLike;

describe("explain on workerd", () => {
    it("reports the plan SQLite chose, naming the index that serves the read", async () => {
        expect.assertions(4);

        const stub = env.SHARD.get(env.SHARD.idFromName("explain"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = { exec: state.storage.sql.exec.bind(state.storage.sql) } as never;

            runShardMigrations(sql, schema);

            const db = createShardCtxDb({ schema, sql });

            await db.insert("messages", { body: "hi", room: "lobby" });

            const indexed = await db.explain("messages", { where: { room: "lobby" } });
            const scanned = await db.explain("messages", { where: { body: "hi" } });

            expect(indexed?.sql).toContain('FROM "messages"');
            expect(indexed?.plan.join("\n")).toContain("by_room");
            expect(scanned?.plan.length).toBeGreaterThan(0);
            expect(scanned?.plan.join("\n")).not.toContain("by_room");
        });
    });
});
