import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorMutatorWrite } from "../src";
import { fromServerSchema } from "../src";
import mutatorFullRowReplace from "../src/lints/static/mutator-full-row-replace";

const schema = () =>
    fromServerSchema(
        defineSchema({
            channels: defineTable({ name: v.string(), topic: v.string() }).shardBy("name"),
        }),
    );

const write = (overrides: Partial<AdvisorMutatorWrite> = {}): AdvisorMutatorWrite => {
    return { exportName: "renameChannel", file: "lunora/mutators.ts", line: 21, ...overrides };
};

describe("mutator_full_row_replace", () => {
    it("finds nothing when no mutatorWrites evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        expect(mutatorFullRowReplace.run({ schema: schema() })).toHaveLength(0);
    });

    it("finds nothing when no mutator performs a whole-row replace", () => {
        expect.assertions(1);

        expect(mutatorFullRowReplace.run({ schema: schema(), mutatorWrites: [] })).toHaveLength(0);
    });

    it("flags a mutator whose server impl writes with `ctx.db.replace(...)`", () => {
        expect.assertions(3);

        const findings = mutatorFullRowReplace.run({ schema: schema(), mutatorWrites: [write()] });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "mutator_full_row_replace:renameChannel:21",
            level: "WARN",
            metadata: { exportName: "renameChannel", file: "lunora/mutators.ts", line: 21 },
            name: "mutator_full_row_replace",
        });
        expect(findings[0]?.detail).toContain("ctx.db.patch");
    });

    it("flags each replace independently, including two in the same mutator", () => {
        expect.assertions(2);

        const findings = mutatorFullRowReplace.run({
            schema: schema(),
            mutatorWrites: [write({ line: 21 }), write({ line: 33 }), write({ exportName: "archiveChannel", line: 48 })],
        });

        expect(findings).toHaveLength(3);
        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual([
            "mutator_full_row_replace:renameChannel:21",
            "mutator_full_row_replace:renameChannel:33",
            "mutator_full_row_replace:archiveChannel:48",
        ]);
    });
});
