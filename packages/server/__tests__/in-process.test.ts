import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";

import type { SqlExec, TransactionHeadroomTracker } from "@lunora/shard-engine";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { DispatchHeadroom } from "../src/dispatch-headroom";
import { createInProcessRuntime, resolveInProcessIdentity, runRegisteredFunction } from "../src/in-process";
import { defineSchema, defineTable } from "../src/schema";

const schema = defineSchema({ notes: defineTable({ body: v.string() }) });

const nodeSqlExec = (): SqlExec => {
    const database = new DatabaseSync(":memory:");

    return {
        exec: <Row>(query: string, ...params: unknown[]) => {
            const rows = database.prepare(query).all(...(params as never[])) as Row[];

            return { one: () => rows[0] as Row, [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows };
        },
    };
};

describe(createInProcessRuntime, () => {
    it("migrates the schema and rolls back every write of a body that throws", async () => {
        expect.assertions(3);

        const runtime = createInProcessRuntime(schema, { sql: nodeSqlExec() });
        const { database } = runtime.createWriters(resolveInProcessIdentity(null));

        await runtime.runInTransaction(async () => database.insert("notes", { body: "kept" }));

        await expect(
            runtime.runInTransaction(async () => {
                await database.insert("notes", { body: "dropped" });

                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        const rows = await runtime.runInTransaction(async () => database.query("notes").collect());

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ body: "kept" });
    });

    it("forwards only a non-empty subject, and its claims without it", () => {
        expect.assertions(3);

        expect(resolveInProcessIdentity({ roles: ["admin"] })).toStrictEqual({ claims: null, userId: null });
        expect(resolveInProcessIdentity({ userId: "ada" })).toStrictEqual({ claims: null, userId: "ada" });
        expect(resolveInProcessIdentity({ roles: ["admin"], userId: "ada" })).toStrictEqual({ claims: { roles: ["admin"] }, userId: "ada" });
    });

    it("refuses an internal function from outside and a reference of the wrong kind", () => {
        expect.assertions(2);

        const internal = { handler: () => 1, kind: "mutation", visibility: "internal" };

        expect(() => runRegisteredFunction("mutation", internal, {}, {}, false)).toThrow("internal function");
        expect(() => runRegisteredFunction("query", internal, {}, {}, true)).toThrow("expected a registered query");
    });
});

describe(DispatchHeadroom, () => {
    it("charges a document again in the next dispatch", () => {
        expect.assertions(1);

        const headroom = new DispatchHeadroom();

        headroom.run(() => {
            headroom.recordDocumentRead("doc", 10);
        });
        headroom.run(() => {
            headroom.recordDocumentRead("doc", 10);
        });

        expect(headroom.headroom().readBytes).toBe(10);
    });

    it("keeps each overlapping dispatch on its own budget", async () => {
        expect.assertions(2);

        const headroom = new DispatchHeadroom(new AsyncLocalStorage<TransactionHeadroomTracker>());
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = headroom.run(async () => {
            headroom.recordReadBytes(10);
            await gate;
            headroom.recordReadBytes(10);

            return headroom.headroom().readBytes;
        });
        const second = headroom.run(async () => {
            headroom.recordReadBytes(1);
            await gate;

            return headroom.headroom().readBytes;
        });

        release();

        await expect(first).resolves.toBe(20);
        await expect(second).resolves.toBe(1);
    });
});
