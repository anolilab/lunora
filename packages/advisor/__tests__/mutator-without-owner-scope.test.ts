import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorMutatorDeclaration } from "../src";
import { fromServerSchema } from "../src";
import mutatorWithoutOwnerScope from "../src/lints/static/mutator-without-owner-scope";

const schema = () =>
    fromServerSchema(
        defineSchema({
            posts: defineTable({ text: v.string(), userId: v.string() }).shardBy("userId"),
        }),
    );

const mutator = (overrides: Partial<AdvisorMutatorDeclaration> = {}): AdvisorMutatorDeclaration => {
    return { exportName: "createPost", file: "lunora/mutators.ts", line: 12, ...overrides };
};

describe("mutator_without_owner_scope", () => {
    it("finds nothing when no mutator evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        expect(mutatorWithoutOwnerScope.run({ schema: schema() })).toHaveLength(0);
    });

    it("finds nothing when the project declares no mutators", () => {
        expect.assertions(1);

        expect(mutatorWithoutOwnerScope.run({ mutators: [], schema: schema() })).toHaveLength(0);
    });

    it("finds nothing for an owner-scoped mutator", () => {
        expect.assertions(1);

        expect(mutatorWithoutOwnerScope.run({ mutators: [mutator({ owner: "userId" })], schema: schema() })).toHaveLength(0);
    });

    it("flags a mutator that declares no owner", () => {
        expect.assertions(3);

        const findings = mutatorWithoutOwnerScope.run({ mutators: [mutator()], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "mutator_without_owner_scope:lunora/mutators.ts:createPost",
            level: "WARN",
            name: "mutator_without_owner_scope",
        });
        expect(findings[0]?.detail).toContain("createPost");
    });

    it("flags each unscoped mutator once, leaving the scoped ones alone", () => {
        expect.assertions(2);

        const findings = mutatorWithoutOwnerScope.run({
            mutators: [mutator(), mutator({ exportName: "bumpCounter", line: 30 }), mutator({ exportName: "renamePost", line: 44, owner: "userId" })],
            schema: schema(),
        });

        expect(findings).toHaveLength(2);
        expect(findings.map((finding) => finding.metadata?.["exportName"])).toStrictEqual(["createPost", "bumpCounter"]);
    });

    it("treats a computed owner as unscoped — the feeder cannot resolve it", () => {
        // `owner: column` arrives as `undefined`, and calling that scoped would
        // fake the guarantee the declaration is supposed to carry.
        expect.assertions(1);

        expect(mutatorWithoutOwnerScope.run({ mutators: [mutator({ owner: undefined })], schema: schema() })).toHaveLength(1);
    });
});
