import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { mutation } = initLunora.dataModel().create();

const schema = defineSchema({
    stamps: defineTable({ at: v.number() }),
});

/** Reads `ctx.now` the way a handler does; production captures it per execution. */
const stamp = mutation.input({}).mutation(async ({ ctx }) => await ctx.db.insert("stamps", { at: ctx.now }));

const harnesses = trackHarnesses();

const start = (options?: Parameters<typeof lunoraTest>[1]): ReturnType<typeof lunoraTest> => harnesses.track(lunoraTest(schema, options));

describe("ctx.now in the harness", () => {
    afterEach(() => {
        vi.useRealTimers();
        harnesses.closeAll();
    });

    it("reads the clock per execution, so a clock moved after setup is seen", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: 1000, toFake: ["Date"] });

        const t = start();

        vi.setSystemTime(5000);

        const id = await t.mutation(stamp, {});
        const row = await t.run(async (ctx) => await ctx.db.get(id));

        expect(row).toMatchObject({ at: 5000 });

        vi.setSystemTime(9000);
        await t.mutation(stamp, {});

        const ats = await t.run(async (ctx) => {
            const rows = await ctx.db.query("stamps").collect();

            return rows.map((entry) => entry.at);
        });

        expect(ats).toStrictEqual([5000, 9000]);
    });

    it("holds one clock for the whole run, even when the clock moves mid-run", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ now: 1000, toFake: ["Date"] });

        const twice = mutation.input({}).mutation(async ({ ctx }) => {
            const before = ctx.now;

            vi.setSystemTime(7000);

            return [before, ctx.now];
        });

        const t = start();

        await expect(t.mutation(twice, {})).resolves.toStrictEqual([1000, 1000]);
    });

    it("keeps a fixed options.now for every context", async () => {
        expect.assertions(1);

        const t = start({ now: 42 });

        const id = await t.mutation(stamp, {});

        await expect(t.run(async (ctx) => await ctx.db.get(id))).resolves.toMatchObject({ at: 42 });
    });
});
