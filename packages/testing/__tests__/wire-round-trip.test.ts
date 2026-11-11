import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { action, mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    log: defineTable({
        message: v.string(),
    }),
});

/** A class instance the wire codec refuses: non-plain objects do not encode. */
class Money {
    public readonly cents: number;

    public constructor(cents: number) {
        this.cents = cents;
    }
}

let capturedObject: { at: Date; n: bigint; skip: undefined } | undefined;

const returnsWireValue = query.query(() => {
    capturedObject = { at: new Date(0), n: 1n, skip: undefined };

    return capturedObject;
});

const returnsMoney = query.query(() => new Money(5));

const insertThenReturnMoney = mutation.mutation(async ({ ctx }) => {
    await ctx.db.insert("log", { message: "written" });

    return new Money(5);
});

const actionReturnsMoney = action.action(() => new Money(5));

const noopMutation = mutation.mutation(() => {});

const listLog = query.query(({ ctx }) => ctx.db.query("log").collect());

const harnesses = trackHarnesses();

const start = (): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema);

    harnesses.track(t);

    return t;
};

describe("lunoraTest wire round-trip", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("hands back a registered query result as the wire decodes it", async () => {
        expect.assertions(3);

        const t = start();

        const result = await t.query(returnsWireValue, {});

        expect(result).toStrictEqual({ at: new Date(0), n: 1n });
        expect(Object.keys(result as object)).not.toContain("skip");
        expect(result).not.toBe(capturedObject);
    });

    it("rejects a registered query whose result the wire cannot encode", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.query(returnsMoney, {})).rejects.toMatchObject({ code: "WIRE_ENCODE_FAILED" });
    });

    it("rolls back a mutation whose result the wire cannot encode", async () => {
        expect.assertions(2);

        const t = start();

        await expect(t.mutation(insertThenReturnMoney, {})).rejects.toMatchObject({ code: "WIRE_ENCODE_FAILED" });
        await expect(t.query(listLog, {})).resolves.toStrictEqual([]);
    });

    it("rejects a registered action whose result the wire cannot encode", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.action(actionReturnsMoney, {})).rejects.toMatchObject({ code: "WIRE_ENCODE_FAILED" });
    });

    it("resolves undefined for a registered mutation that returns nothing", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.mutation(noopMutation, {})).resolves.toBeUndefined();
    });

    it("keeps the inline query form returning the same object by reference", async () => {
        expect.assertions(1);

        const t = start();
        const inlineValue = { kept: true };

        const result = await t.query(() => inlineValue);

        expect(result).toBe(inlineValue);
    });
});
