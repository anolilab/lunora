import type { Topics } from "@lunora/queue";
import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { action, mutation } = initLunora.dataModel().create();

const schema = defineSchema({
    users: defineTable({
        email: v.string(),
    }),
});

/** The slice of a generated ctx these handlers use; codegen types it in an app. */
type WithTopics = { topics: Topics<"audit" | "signups"> };

const signUp = mutation.input({ email: v.string() }).mutation(async ({ args, ctx }) => {
    const id = await ctx.db.insert("users", { email: args.email });

    await (ctx as unknown as WithTopics).topics.signups.publish({ email: args.email, id });

    return id;
});

const auditBatch = action.input({ count: v.number() }).action(async ({ args, ctx }) => {
    await (ctx as unknown as WithTopics).topics.audit.publishBatch(
        Array.from({ length: args.count }, (_, index) => {
            return { body: { index } };
        }),
        { delaySeconds: 30 },
    );
});

const publishTooLate = mutation.input({}).mutation(async ({ ctx }) => {
    await (ctx as unknown as WithTopics).topics.signups.publish({}, { delaySeconds: 50_000 });
});

const publishToUndeclared = mutation.input({}).mutation(async ({ ctx }) => {
    await (ctx as unknown as { topics: Topics<"typo"> }).topics.typo.publish({});
});

/** Swallows a failing publish, the way "an event must not fail the signup" code does. */
const publishBestEffort = mutation.input({}).mutation(async ({ ctx }) => {
    try {
        await (ctx as unknown as WithTopics).topics.signups.publish({});
    } catch {
        // best effort
    }
});

const harnesses = trackHarnesses();

const start = (options?: Parameters<typeof lunoraTest>[1]): ReturnType<typeof lunoraTest> => harnesses.track(lunoraTest(schema, options));

describe("recording ctx.topics", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("records a publish from a mutation under its topic name", async () => {
        expect.assertions(2);

        const t = start({ topics: ["audit", "signups"] });
        const id = await t.mutation(signUp, { email: "a@example.test" });

        expect(t.topics.published("signups")).toStrictEqual([{ body: { email: "a@example.test", id }, contentType: "json", topic: "signups" }]);
        expect(t.topics.published("audit")).toStrictEqual([]);
    });

    it("records each message of a batch publish from an action, with the batch's delay", async () => {
        expect.assertions(1);

        const t = start({ topics: ["audit"] });

        await t.action(auditBatch, { count: 2 });

        expect(t.topics.published()).toStrictEqual([
            { body: { index: 0 }, contentType: "json", delaySeconds: 30, topic: "audit" },
            { body: { index: 1 }, contentType: "json", delaySeconds: 30, topic: "audit" },
        ]);
    });

    it("applies @lunora/queue's own validation and records nothing it rejects", async () => {
        expect.assertions(4);

        const t = start({ topics: ["audit", "signups"] });

        await expect(t.mutation(publishTooLate, {})).rejects.toThrow(/ceiling of 43200/u);
        await expect(t.mutation(publishToUndeclared, {})).rejects.toThrow(/no topic named "typo" \(known topics: audit, signups\)/u);
        await expect(t.action(auditBatch, { count: 101 })).rejects.toThrow(/exceeds 100 \(got 101\)/u);
        expect(t.topics.published()).toStrictEqual([]);
    });

    it("throws on published() for an undeclared topic, and clear() forgets what was published", async () => {
        expect.assertions(2);

        const t = start({ topics: ["signups"] });

        await t.mutation(signUp, { email: "a@example.test" });

        expect(() => t.topics.published("signup")).toThrow(/harness\.topics\.published\("signup"\): no such topic — declared: signups/u);

        t.topics.clear();

        expect(t.topics.published()).toStrictEqual([]);
    });

    it("without the option, ctx.topics and published() both throw naming it — so a swallowed publish cannot pass vacuously", async () => {
        expect.assertions(3);

        const t = start();

        await expect(t.mutation(signUp, { email: "a@example.test" })).rejects.toThrow(/ctx\.topics is not enabled .* \{ topics: \[\.\.\.\] \}/u);
        await expect(t.mutation(publishBestEffort, {})).resolves.toBeUndefined();
        expect(() => t.topics.published()).toThrow(/pass lunoraTest\(schema, \{ topics: \[\.\.\.\] \}\)/u);
    });
});
