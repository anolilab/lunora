import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DatabaseWriterLike, SchedulerLike, SchemaLike, TriggerContextLike, TriggerEventLike } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * Exercises lifecycle triggers against a real SQLite engine (workerd can't run
 * in the sandbox). Triggers are dialect-agnostic, so proving the firing order,
 * event payloads, abort semantics, and recursion guard here covers the same
 * `runTriggers` path the D1 backend takes.
 */

let harness: ReturnType<typeof createSqliteExec>;

const makeWriter = (schema: SchemaLike, scheduler?: SchedulerLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardCtxDb({ clock: () => 1_700_000_000_000, schema, scheduler, sql: harness.sql });
};

beforeEach(() => {
    harness = createSqliteExec();
});

afterEach(() => {
    harness.close();
});

describe("trigger firing", () => {
    test("before/after insert fire in order with the new doc", async () => {
        const events: Array<{ doc?: unknown; phase: string }> = [];
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" } },
                    triggerMap: {
                        a: { handler: (_ctx, event) => void events.push({ doc: event.doc, phase: "after" }), op: "insert", timing: "after" },
                        b: { handler: (_ctx, event) => void events.push({ doc: event.doc, phase: "before" }), op: "insert", timing: "before" },
                    },
                },
            },
        };
        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m1", body: "hi" });

        expect(events.map((e) => e.phase)).toEqual(["before", "after"]);
        expect((events[0]!.doc as Record<string, unknown>)["body"]).toBe("hi");
        expect((events[1]!.doc as Record<string, unknown>)["_id"]).toBe("m1");
    });

    test("update triggers see merged doc and previous on patch", async () => {
        let captured: TriggerEventLike | undefined;
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" } },
                    triggerMap: {
                        a: {
                            handler: (_ctx, event) => {
                                captured = event;
                            },
                            op: "update",
                            timing: "after",
                        },
                    },
                },
            },
        };
        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m1", body: "hi" });
        await writer.patch("m1", { body: "bye" });

        expect(captured!.op).toBe("update");
        expect((captured!.doc as Record<string, unknown>)["body"]).toBe("bye");
        expect((captured!.previous as Record<string, unknown>)["body"]).toBe("hi");
    });

    test("replace supplies previous only when an update trigger exists", async () => {
        let captured: TriggerEventLike | undefined;
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" } },
                    triggerMap: {
                        a: {
                            handler: (_ctx, event) => {
                                captured = event;
                            },
                            op: "update",
                            timing: "before",
                        },
                    },
                },
            },
        };
        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m1", body: "hi" });
        await writer.replace("m1", { body: "fresh" });

        expect((captured!.previous as Record<string, unknown>)["body"]).toBe("hi");
        expect((captured!.doc as Record<string, unknown>)["body"]).toBe("fresh");
    });

    test("delete triggers see previous; after fires once removed", async () => {
        const events: Array<{ phase: string; previous?: unknown }> = [];
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" } },
                    triggerMap: {
                        a: { handler: (_ctx, event) => void events.push({ phase: "before", previous: event.previous }), op: "delete", timing: "before" },
                        b: { handler: (_ctx, event) => void events.push({ phase: "after", previous: event.previous }), op: "delete", timing: "after" },
                    },
                },
            },
        };
        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m1", body: "hi" });
        await writer.delete("m1");

        expect(events.map((e) => e.phase)).toEqual(["before", "after"]);
        expect((events[0]!.previous as Record<string, unknown>)["body"]).toBe("hi");
        await expect(writer.get("m1")).resolves.toBeNull();
    });

    test("a throwing beforeDelete aborts the delete — the row survives", async () => {
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" }, locked: { kind: "boolean" } },
                    triggerMap: {
                        guard: {
                            handler: (_ctx, event) => {
                                if ((event.previous as Record<string, unknown>)["locked"]) {
                                    throw new Error("row is locked");
                                }
                            },
                            op: "delete",
                            timing: "before",
                        },
                    },
                },
            },
        };
        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m1", body: "hi", locked: true });

        await expect(writer.delete("m1")).rejects.toThrow(/row is locked/);
        await expect(writer.get("m1")).resolves.not.toBeNull();
    });

    test("an afterInsert handler writing another table via ctx.db persists", async () => {
        const schema: SchemaLike = {
            tables: {
                audit: { indexes: [], shape: { row: { kind: "string" }, table: { kind: "string" } }, triggerMap: {} },
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" } },
                    triggerMap: {
                        audit: {
                            handler: async (ctx, event) => {
                                await ctx.db.insert("audit", { row: event.id, table: event.table });
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        };
        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m1", body: "hi" });

        const { page } = await writer.findMany("audit");

        expect(page).toHaveLength(1);
        expect(page[0]!["row"]).toBe("m1");
        expect(page[0]!["table"]).toBe("messages");
    });

    test("cascade delete fires the child table's delete triggers", async () => {
        const deletedReactions: string[] = [];
        const schema: SchemaLike = {
            tables: {
                reactions: {
                    indexes: [{ fields: ["messageId"], name: "by_message" }],
                    // The child holds the cascade rule: deleting a message cascades to its reactions.
                    relationMap: { message: { field: "messageId", kind: "one", onDelete: "cascade", references: "_id", table: "messages" } },
                    shape: { emoji: { kind: "string" }, messageId: { kind: "string" } },
                    triggerMap: {
                        track: { handler: (_ctx, event) => void deletedReactions.push(event.id), op: "delete", timing: "after" },
                    },
                },
                messages: {
                    indexes: [],
                    relationMap: { reactions: { field: "messageId", kind: "many", references: "_id", table: "reactions" } },
                    shape: { body: { kind: "string" } },
                    triggerMap: {},
                },
            },
        };

        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m1", body: "hi" });
        await writer.insert("reactions", { _id: "r1", emoji: "👍", messageId: "m1" });
        await writer.insert("reactions", { _id: "r2", emoji: "🎉", messageId: "m1" });

        await writer.delete("m1");

        expect([...deletedReactions].sort()).toEqual(["r1", "r2"]);
    });

    test("ctx.scheduler reaches the injected scheduler", async () => {
        const runAfter = vi.fn(async () => "job-1");
        const scheduler: SchedulerLike = { runAfter, runAt: async () => "job-2" };
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" } },
                    triggerMap: {
                        bump: {
                            handler: async (ctx, event) => {
                                await ctx.scheduler.runAfter(0, "counters:recount", { id: event.id });
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        };
        const writer = makeWriter(schema, scheduler);

        await writer.insert("messages", { _id: "m1", body: "hi" });

        expect(runAfter).toHaveBeenCalledWith(0, "counters:recount", { id: "m1" });
    });

    test("the default scheduler throws when a trigger uses it unconfigured", async () => {
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" } },
                    triggerMap: {
                        bump: {
                            handler: async (ctx) => {
                                await ctx.scheduler.runAfter(0, "noop");
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        };
        const writer = makeWriter(schema);

        await expect(writer.insert("messages", { _id: "m1", body: "hi" })).rejects.toThrow(/no scheduler configured/);
    });

    test("the recursion-depth guard aborts a self-triggering loop", async () => {
        const schema: SchemaLike = {
            tables: {
                messages: {
                    indexes: [],
                    shape: { body: { kind: "string" } },
                    triggerMap: {
                        loop: {
                            handler: async (ctx: TriggerContextLike) => {
                                // Each insert refires this same after-insert trigger → unbounded recursion.
                                await ctx.db.insert("messages", { body: "again" });
                            },
                            op: "insert",
                            timing: "after",
                        },
                    },
                },
            },
        };
        const writer = makeWriter(schema);

        await expect(writer.insert("messages", { _id: "m1", body: "hi" })).rejects.toThrow(/trigger recursion exceeded/);
    });
});
