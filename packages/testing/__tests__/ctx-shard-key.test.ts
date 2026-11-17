import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    notes: defineTable({ body: v.string() }),
});

const whereAmI = query.input({}).query(async ({ ctx }) => ctx.shardKey);
const whereDoIWrite = mutation.input({}).mutation(async ({ ctx }) => ctx.shardKey);

const harnesses = trackHarnesses();

describe("ctx.shardKey in the harness", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("reports the root shard by default, as a call that names none does", async () => {
        expect.assertions(2);

        const t = harnesses.track(lunoraTest(schema));

        await expect(t.query(whereAmI, {})).resolves.toBe("__root__");
        await expect(t.mutation(whereDoIWrite, {})).resolves.toBe("__root__");
    });

    it("reports the shard the suite says it runs on", async () => {
        expect.assertions(1);

        const t = harnesses.track(lunoraTest(schema, { shardKey: "org_1" }));

        await expect(t.query(whereAmI, {})).resolves.toBe("org_1");
    });
});
