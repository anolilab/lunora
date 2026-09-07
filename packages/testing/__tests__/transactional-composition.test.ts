/**
 * The two composition promises the docs make about mutations, pinned end to end.
 *
 * The first: "An action's `ctx.db` writes are **not** part of a single mutation
 * transaction. Do transactional reads and writes inside a `mutation` and call it
 * from the action" (`concepts/function-context.mdx`, and the same recipe in
 * `concepts/internal-functions.mdx`, `packages/server/docs`,
 * `packages/hyperdrive/docs` and the `lunora-functions` skill). That only holds
 * if the composed mutation gets its own BEGIN/COMMIT span — otherwise every write
 * autocommits and a mid-handler throw leaves the earlier ones behind, which is
 * the exact failure the recipe is prescribed to avoid.
 *
 * The second: "`runAfter(0, ...)` is the idiomatic 'do this right after I commit,
 * but not in my transaction' hand-off … the deterministic equivalent of an
 * `afterCommit` hook" (`concepts/scheduling.mdx`, `packages/server/docs`). A job
 * scheduled by a mutation that then rolls back must not survive it.
 *
 * The harness mirrors the generated shard's dispatch, so these assertions are the
 * behavioural half of the emitter's `emit-shard-transactional-run.test.ts`.
 */
import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";

const { action, mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({ messages: defineTable({ body: v.string() }) });

/** Two writes, then a throw: the classic "order row landed, ledger row did not". */
const insertThenThrow = mutation.mutation(async ({ ctx }) => {
    await ctx.db.insert("messages", { body: "a" });
    await ctx.db.insert("messages", { body: "b" });

    throw new Error("boom after two inserts");
});

const insertOne = mutation.mutation(async ({ ctx }) => {
    await ctx.db.insert("messages", { body: "composed" });
});

const list = query.query(async ({ ctx }) => ctx.db.query("messages").collect());

/** The documented shape: the action swallows the failure and carries on. */
const composeFailing = action.action(async ({ ctx }) => {
    try {
        await ctx.runMutation(insertThenThrow, {});
    } catch (error) {
        return `caught: ${(error as Error).message}`;
    }

    return "no throw";
});

const composeSucceeding = action.action(async ({ ctx }) => {
    await ctx.runMutation(insertOne, {});

    return "ok";
});

const scheduleThenThrow = mutation.mutation(async ({ ctx }) => {
    await ctx.db.insert("messages", { body: "with-job" });
    await ctx.scheduler.runAfter(0, "messages:noop", {});

    throw new Error("boom after runAfter");
});

const scheduleThenCommit = mutation.mutation(async ({ ctx }) => {
    await ctx.db.insert("messages", { body: "with-job" });

    return ctx.scheduler.runAfter(0, "messages:noop", {});
});

const scheduleTwice = mutation.mutation(async ({ ctx }) => {
    await ctx.scheduler.runAfter(0, "messages:first", {});
    await ctx.scheduler.runAfter(0, "messages:second", {});
});

const composeScheduleThenThrow = action.action(async ({ ctx }) => {
    try {
        await ctx.runMutation(scheduleThenThrow, {});
    } catch {
        return "caught";
    }

    return "no throw";
});

const harness = (): ReturnType<typeof lunoraTest> => lunoraTest(schema);

describe("mutation composed from an action", () => {
    it("rolls back every write when the composed mutation throws", async () => {
        expect.assertions(2);

        const t = harness();

        try {
            await expect(t.action(composeFailing, {})).resolves.toBe("caught: boom after two inserts");

            // The whole point of the documented recipe: the two inserts are one
            // atomic unit even though the caller is an action.
            await expect(t.query(list, {})).resolves.toHaveLength(0);
        } finally {
            t.close();
        }
    });

    it("commits the composed mutation's writes when it returns", async () => {
        expect.assertions(2);

        const t = harness();

        try {
            await expect(t.action(composeSucceeding, {})).resolves.toBe("ok");
            await expect(t.query(list, {})).resolves.toHaveLength(1);
        } finally {
            t.close();
        }
    });

    it("discards jobs the composed mutation scheduled before it threw", async () => {
        expect.assertions(3);

        const t = harness();

        try {
            await expect(t.action(composeScheduleThenThrow, {})).resolves.toBe("caught");
            await expect(t.query(list, {})).resolves.toHaveLength(0);
            expect(t.scheduler.list()).toHaveLength(0);
        } finally {
            t.close();
        }
    });
});

describe("ctx.scheduler inside a mutation", () => {
    it("drops the job when the mutation rolls back", async () => {
        expect.assertions(3);

        const t = harness();

        try {
            await expect(t.mutation(scheduleThenThrow, {})).rejects.toThrow("boom after runAfter");
            await expect(t.query(list, {})).resolves.toHaveLength(0);

            // The row is gone; a receipt job for a write that never landed must go
            // with it.
            expect(t.scheduler.list()).toHaveLength(0);
        } finally {
            t.close();
        }
    });

    it("enqueues the job under the id the handler was given once the mutation commits", async () => {
        expect.assertions(3);

        const t = harness();

        try {
            const id = await t.mutation(scheduleThenCommit, {});
            const pending = t.scheduler.list();

            expect(pending).toHaveLength(1);
            expect(pending[0]?.functionPath).toBe("messages:noop");
            // The handler stores this id on the row it just wrote so it can cancel
            // later, so a buffered call must answer the id the job really gets.
            expect(pending[0]?.id).toBe(id);
        } finally {
            t.close();
        }
    });

    it("flushes buffered jobs in declaration order", async () => {
        expect.assertions(1);

        const t = harness();

        try {
            await t.mutation(scheduleTwice, {});

            expect(t.scheduler.list().map((job) => job.functionPath)).toStrictEqual(["messages:first", "messages:second"]);
        } finally {
            t.close();
        }
    });

    it("still rejects a negative delay at the call site, not at the flush", async () => {
        expect.assertions(2);

        const t = harness();
        const badDelay = mutation.mutation(async ({ ctx }) => {
            await ctx.scheduler.runAfter(-1, "messages:noop", {});
        });

        try {
            // Buffered, the guard would not fire until after the COMMIT — turning a
            // caller's bad argument into a failure on a mutation that succeeded.
            await expect(t.mutation(badDelay, {})).rejects.toThrow("non-negative finite number");
            expect(t.scheduler.list()).toHaveLength(0);
        } finally {
            t.close();
        }
    });
});

describe("ctx.scheduler inside an action", () => {
    it("schedules immediately — an action has no transaction to wait for", async () => {
        expect.assertions(1);

        const t = harness();
        const observe = action.action(async ({ ctx }) => {
            await ctx.scheduler.runAfter(0, "messages:noop", {});

            // Read back from inside the same dispatch: an action's schedule is not
            // held, so it is already pending here.
            return ctx.scheduler.list();
        });

        try {
            await expect(t.action(observe, {})).resolves.toHaveLength(1);
        } finally {
            t.close();
        }
    });
});
