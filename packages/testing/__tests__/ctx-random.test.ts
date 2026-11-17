import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { mutation } = initLunora.dataModel().create();

const schema = defineSchema({
    draws: defineTable({ value: v.number() }),
});

/** Draws `ctx.random()` once, unkeyed, the way a handler outside a replay does. */
const draw = mutation.input({}).mutation(async ({ ctx }) => await ctx.db.insert("draws", { value: ctx.random() }));

const harnesses = trackHarnesses();

const start = (): ReturnType<typeof lunoraTest> => harnesses.track(lunoraTest(schema));

describe("ctx.random in the harness", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        harnesses.closeAll();
    });

    it("draws from Math.random without a replay key, as production does", async () => {
        expect.assertions(1);

        vi.spyOn(Math, "random").mockReturnValue(0.25);

        const t = start();
        const id = await t.mutation(draw, {});
        const row = await t.run(async (ctx) => await ctx.db.get("draws", id));

        expect(row).toMatchObject({ value: 0.25 });
    });
});
