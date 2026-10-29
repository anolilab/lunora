import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { SchemaIR } from "../src/ir";
import { makeGeneratedShard, transactionalHost } from "./_helpers/generated-composition";

const writePaths = {
    db: `await ctx.db.insert("messages", { body: "message" });`,
    table: `await ctx.db.messages.insert({ body: "message" });`,
    orm: `await ctx.orm.insert("messages").values({ body: "message" });`,
} as const;
const cases = (Object.keys(writePaths) as (keyof typeof writePaths)[]).flatMap((writePath) =>
    [false, true].flatMap((lazyFunctions) =>
        [false, true].map((rollback) => {
            return { lazyFunctions, rollback, writePath };
        }),
    ),
);

describe("composed mutation trigger scheduling", () => {
    it.each(cases)("keeps trigger jobs in the mutation outcome: %j", async ({ lazyFunctions, rollback, writePath }) => {
        expect.hasAssertions();

        const root = mkdtempSync(join(tmpdir(), "lunora-trigger-schedule-"));
        mkdirSync(join(root, "lunora"));
        const database = new DatabaseSync(":memory:");
        const key = `__trigger${randomUUID()}`;
        const events: string[] = [];
        Reflect.set(globalThis, key, { events });
        const shared = `const state = globalThis[${JSON.stringify(key)}];\n`;
        const schema = `${shared}export default { vectorIndexes: [], tables: { messages: {
            indexes: [], shape: { body: { kind: "string" } }, triggerMap: {
                schedule: { op: "insert", timing: "after", handler: async (ctx) => {
                    state.events.push("trigger");
                    await ctx.scheduler.runAfter(0, "trigger-job", {});
                } },
            },
        } } };`;
        const schemaIr: SchemaIR = {
            tables: [
                {
                    indexes: [],
                    name: "messages",
                    rankIndexes: [],
                    relations: [],
                    searchIndexes: [],
                    shape: { body: { kind: "string" } },
                    shardMode: "root",
                    vectorIndexes: [],
                },
            ],
            vectorIndexes: [],
        };
        writeFileSync(
            join(root, "lunora", "action.ts"),
            `export const run = { args: {}, kind: "action", handler: async (ctx) => {
            try { await ctx.runMutation({ __lunoraRef: "cold:write" }, {}); } catch (error) { return error.message; }
            return "committed";
        } };`,
        );
        writeFileSync(
            join(root, "lunora", "cold.ts"),
            `${shared}export const write = { args: {}, kind: "mutation", handler: async (ctx) => {
            ${writePaths[writePath]}
            state.events.push("inserted");
            ${rollback ? 'throw new Error("rolled back");' : ""}
        } };`,
        );
        writeFileSync(join(root, "lunora", "blocker.ts"), 'export const block = { args: {}, kind: "mutation", handler: () => undefined };');
        try {
            const host = transactionalHost(database);
            const hostState = host.state as { storage: { transaction: <T>(work: () => Promise<T>) => Promise<T> } };
            const transaction = hostState.storage.transaction.bind(hostState.storage);
            hostState.storage.transaction = async <T>(work: () => Promise<T>): Promise<T> => {
                try {
                    const result = await transaction(work);
                    events.push("committed");
                    return result;
                } catch (error) {
                    events.push("rolled back");
                    throw error;
                }
            };
            const deliveries: { outboxRows: number; target: string }[] = [];
            const Shard = await makeGeneratedShard(
                root,
                lazyFunctions,
                {
                    scheduler: () => {
                        return {
                            runAfter: async (_when: number, target: string) => {
                                events.push("scheduled");
                                const hasOutbox = database.prepare("SELECT name FROM sqlite_master WHERE name = '__schedule_outbox'").get();
                                const outboxRows = hasOutbox
                                    ? (database.prepare("SELECT COUNT(*) AS n FROM __schedule_outbox").get() as { n: number })
                                    : { n: 0 };
                                deliveries.push({ outboxRows: outboxRows.n, target });
                                return target;
                            },
                        };
                    },
                },
                "action",
                "mutation",
                schema,
                schemaIr,
            );
            const shard = new Shard(host.state, {});

            const response = await shard.handleRpc("action:run", {});

            expect(response).toBe(rollback ? "rolled back" : "committed");
            expect(database.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: rollback ? 0 : 1 });
            expect(events).toEqual(rollback ? ["trigger", "inserted", "rolled back"] : ["trigger", "inserted", "committed", "scheduled"]);
            expect(deliveries).toEqual(rollback ? [] : [{ target: "trigger-job", outboxRows: 1 }]);
        } finally {
            Reflect.deleteProperty(globalThis, key);
            database.close();
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("binds a memoized payment facade to the ctx that reads it", async () => {
        expect.hasAssertions();

        const root = mkdtempSync(join(tmpdir(), "lunora-trigger-payment-binding-"));
        mkdirSync(join(root, "lunora"));
        const database = new DatabaseSync(":memory:");
        const key = `__payment${randomUUID()}`;
        const state: { actionDb?: unknown; mutationDb?: unknown } = {};
        Reflect.set(globalThis, key, state);
        const shared = `const state = globalThis[${JSON.stringify(key)}];\n`;
        writeFileSync(
            join(root, "lunora", "action.ts"),
            `${shared}export const run = { args: {}, kind: "action", handler: async (ctx) => {
            state.actionDb = ctx.db;
            try { await ctx.payments.createCheckout({ referenceId: "action", priceId: "price", mode: "payment", successUrl: "https://example.test/success" }); } catch {}
            await ctx.runMutation({ __lunoraRef: "cold:write" }, {});
            return "committed";
        } };`,
        );
        writeFileSync(
            join(root, "lunora", "cold.ts"),
            `${shared}export const write = { args: {}, kind: "mutation", handler: async (ctx) => {
            state.mutationDb = ctx.db;
            try { await ctx.payments.createCheckout({ referenceId: "mutation", priceId: "price", mode: "payment", successUrl: "https://example.test/success" }); } catch {}
        } };`,
        );
        writeFileSync(join(root, "lunora", "blocker.ts"), 'export const block = { args: {}, kind: "mutation", handler: () => undefined };');
        try {
            const host = transactionalHost(database);
            const paymentDatabases = new Map<string, unknown>();
            const Shard = await makeGeneratedShard(
                root,
                false,
                {
                    payment: () => {
                        return {
                            adapter: { identifier: "test" },
                            authorize: (referenceId: string, caller: { db: unknown }) => {
                                paymentDatabases.set(referenceId, caller.db);
                                return false;
                            },
                        };
                    },
                },
                "action",
                "mutation",
                undefined,
                undefined,
                new Set(["payments"] as const),
            );
            const shard = new Shard(host.state, {});

            await expect(shard.handleRpc("action:run", {})).resolves.toBe("committed");

            expect(paymentDatabases.get("action")).toBe(state.actionDb);
            expect(paymentDatabases.get("mutation")).toBe(state.mutationDb);
            expect(paymentDatabases.get("mutation")).not.toBe(paymentDatabases.get("action"));
        } finally {
            Reflect.deleteProperty(globalThis, key);
            database.close();
            rmSync(root, { force: true, recursive: true });
        }
    });
});
