import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import { makeArgumentDerivedSinkLint } from "../src/lints/argument-derived-sink";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

interface StubAccess {
    id: string;
}

const makeStubLint = (getAccesses: () => ReadonlyArray<StubAccess> | undefined) =>
    makeArgumentDerivedSinkLint<StubAccess>({
        cacheKey: (access) => `stub:${access.id}`,
        categories: ["SECURITY"],
        description: "stub",
        detail: (access) => `stub ${access.id}`,
        facing: "EXTERNAL",
        getAccesses,
        level: "WARN",
        metadata: (access) => {
            return { id: access.id };
        },
        name: "stub_lint",
        remediation: "stub",
        title: "Stub",
    });

describe("makeArgumentDerivedSinkLint", () => {
    it("returns no findings when getAccesses returns undefined", () => {
        expect.assertions(1);

        const lint = makeStubLint(() => undefined);

        expect(lint.run({ schema: schema() })).toHaveLength(0);
    });

    it("returns no findings when getAccesses returns an empty array", () => {
        expect.assertions(1);

        const lint = makeStubLint(() => []);

        expect(lint.run({ schema: schema() })).toHaveLength(0);
    });
});
