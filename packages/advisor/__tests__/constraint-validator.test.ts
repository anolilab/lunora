import { defineSchema, defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";
import { describe, expect, it } from "vitest";

import type { AdvisorTableSample } from "../src";
import { constraintValidator, fromServerSchema } from "../src";

/** Build a minimal AdvisorTableSample for testing. */
const makeSample = (table: string, rows: Record<string, unknown>[], opts: { cap?: number; truncated?: boolean } = {}): AdvisorTableSample => {
    const cap = opts.cap ?? rows.length;

    return {
        cap,
        existingIds: new Set(rows.map((r) => (typeof r["_id"] === "string" ? r["_id"] : ""))),
        rows,
        table,
        truncated: opts.truncated ?? false,
    };
};

const schema = fromServerSchema(
    defineSchema({
        comments: defineTable({ postId: v.id("posts"), text: v.string() }).relations((r) => {
            return { post: r.one("posts", { field: "postId" }) };
        }),
        posts: defineTable({ authorId: v.id("users"), title: v.string() })
            .index("byAuthor", ["authorId"])
            .index("byTitle", ["title"], { unique: true })
            .relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
        users: defineTable({ email: v.string() }).index("byEmail", ["email"], { unique: true }),
    }),
);

describe("constraint_validator", () => {
    it("finds nothing when tableSamples is absent", () => {
        expect.assertions(1);

        expect(constraintValidator.run({ schema })).toHaveLength(0);
    });

    it("finds nothing when tableSamples is empty", () => {
        expect.assertions(1);

        expect(constraintValidator.run({ schema, tableSamples: [] })).toHaveLength(0);
    });

    it("finds nothing on clean data with no violations", () => {
        expect.assertions(1);

        const userSample = makeSample("users", [
            { _id: "u1", email: "a@b.com" },
            { _id: "u2", email: "c@d.com" },
        ]);
        const postSample = makeSample("posts", [{ _id: "p1", authorId: "u1", title: "Hello" }]);
        const commentSample = makeSample("comments", [{ _id: "c1", postId: "p1", text: "Hi" }]);

        const findings = constraintValidator.run({ schema, tableSamples: [userSample, postSample, commentSample] });

        expect(findings).toHaveLength(0);
    });

    describe("fK referential integrity", () => {
        it("flags a dangling FK value (referenced row does not exist)", () => {
            expect.assertions(3);

            const userSample = makeSample("users", [{ _id: "u1", email: "a@b.com" }]);
            // posts.authorId "u999" does not exist in userSample.
            const postSample = makeSample("posts", [{ _id: "p1", authorId: "u999", title: "Orphan" }]);

            const findings = constraintValidator.run({ schema, tableSamples: [userSample, postSample] });

            expect(findings.some((f) => f.metadata["kind"] === "fk" && f.metadata["table"] === "posts")).toBe(true);

            const fkFinding = findings.find((f) => f.metadata["kind"] === "fk" && f.metadata["table"] === "posts");

            expect(fkFinding?.metadata["column"]).toBe("authorId");
            expect(fkFinding?.metadata["referencesTable"]).toBe("users");
        });

        it("skips FK check when the target table has no sample", () => {
            expect.assertions(1);

            // Only comments sample provided — no users sample → can't check FK.
            const commentSample = makeSample("comments", [{ _id: "c1", postId: "ghost_post", text: "Hi" }]);

            // No FK finding because we have no posts sample to cross-check against.
            const findings = constraintValidator.run({ schema, tableSamples: [commentSample] });

            expect(findings.filter((f) => f.metadata["kind"] === "fk")).toHaveLength(0);
        });

        it("skips null/undefined FK values (null is not a dangling reference)", () => {
            expect.assertions(1);

            const userSample = makeSample("users", [{ _id: "u1", email: "a@b.com" }]);
            // authorId is null — skip, not a FK violation.
            const postSample = makeSample("posts", [{ _id: "p1", authorId: null, title: "Draft" }]);

            const findings = constraintValidator.run({ schema, tableSamples: [userSample, postSample] });

            // No FK finding for the null authorId.
            expect(findings.filter((f) => f.metadata["kind"] === "fk" && f.metadata["column"] === "authorId")).toHaveLength(0);
        });
    });

    describe("nOT NULL violations", () => {
        it("flags a null value in a declared non-optional column", () => {
            expect.assertions(2);

            const postSample = makeSample("posts", [
                { _id: "p1", authorId: null, title: "OK" },
                { _id: "p2", authorId: "u1", title: null },
            ]);
            const userSample = makeSample("users", [{ _id: "u1", email: "a@b.com" }]);

            const findings = constraintValidator.run({ schema, tableSamples: [userSample, postSample] });
            const nullFindings = findings.filter((f) => f.metadata["kind"] === "null" && f.metadata["table"] === "posts");

            // authorId null in p1, title null in p2 → two null findings.
            expect(nullFindings.length).toBeGreaterThanOrEqual(1);
            expect(nullFindings.some((f) => f.metadata["column"] === "title")).toBe(true);
        });

        it("flags an undefined (absent) column value as null", () => {
            expect.assertions(1);

            // Row has no `title` key — treated as null/missing.
            const postSample = makeSample("posts", [{ _id: "p1", authorId: "u1" }]);
            const userSample = makeSample("users", [{ _id: "u1", email: "a@b.com" }]);

            const findings = constraintValidator.run({ schema, tableSamples: [userSample, postSample] });
            const nullFindings = findings.filter((f) => f.metadata["kind"] === "null" && f.metadata["table"] === "posts" && f.metadata["column"] === "title");

            expect(nullFindings).toHaveLength(1);
        });
    });

    describe("uNIQUE violations", () => {
        it("flags duplicate values on a unique index", () => {
            expect.assertions(2);

            // Two users with the same email — violates unique index byEmail.
            const userSample = makeSample("users", [
                { _id: "u1", email: "dup@example.com" },
                { _id: "u2", email: "dup@example.com" },
            ]);

            const findings = constraintValidator.run({ schema, tableSamples: [userSample] });
            const uniqueFinding = findings.find((f) => f.metadata["kind"] === "unique" && f.metadata["table"] === "users");

            expect(uniqueFinding).toBeDefined();
            expect(uniqueFinding?.metadata["index"]).toBe("byEmail");
        });

        it("passes when all unique-indexed values are distinct", () => {
            expect.assertions(1);

            const userSample = makeSample("users", [
                { _id: "u1", email: "a@b.com" },
                { _id: "u2", email: "c@d.com" },
            ]);

            const findings = constraintValidator.run({ schema, tableSamples: [userSample] });

            expect(findings.filter((f) => f.metadata["kind"] === "unique")).toHaveLength(0);
        });

        it("ignores null values in unique index fields (NULL != NULL in SQL)", () => {
            expect.assertions(1);

            // Both rows have null email — SQL UNIQUE allows multiple NULLs.
            const userSample = makeSample("users", [
                { _id: "u1", email: null },
                { _id: "u2", email: null },
            ]);

            const findings = constraintValidator.run({ schema, tableSamples: [userSample] });

            expect(findings.filter((f) => f.metadata["kind"] === "unique")).toHaveLength(0);
        });
    });

    it("notes the sample cap in the finding detail when truncated", () => {
        expect.assertions(1);

        const userSample = makeSample("users", [{ _id: "u1", email: "a@b.com" }], { cap: 100, truncated: true });
        // posts.authorId "ghost" dangling, and sample is truncated.
        const postSample = makeSample("posts", [{ _id: "p1", authorId: "ghost", title: "Hello" }]);

        const findings = constraintValidator.run({ schema, tableSamples: [userSample, postSample] });
        const fkFinding = findings.find((f) => f.metadata["kind"] === "fk");

        expect(fkFinding?.detail).toContain("capped");
    });

    it("sets cacheKey, name, and level correctly", () => {
        expect.assertions(3);

        const userSample = makeSample("users", [
            { _id: "u1", email: "dup@a.com" },
            { _id: "u2", email: "dup@a.com" },
        ]);
        const [finding] = constraintValidator.run({ schema, tableSamples: [userSample] });

        expect(finding?.name).toBe("constraint_validator");
        expect(finding?.level).toBe("WARN");
        expect(finding?.cacheKey).toMatch(/^constraint_validator:/);
    });
});
