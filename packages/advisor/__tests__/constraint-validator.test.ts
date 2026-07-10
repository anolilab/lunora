import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
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

    it("notes the sample cap in the finding detail when the source is truncated", () => {
        expect.assertions(1);

        // The FK target (users) is complete; the referencing sample (posts) is
        // truncated, so the caveat means "more violations may exist beyond the
        // window" — which is the case where noting the cap is correct.
        const userSample = makeSample("users", [{ _id: "u1", email: "a@b.com" }]);
        const postSample = makeSample("posts", [{ _id: "p1", authorId: "ghost", title: "Hello" }], { cap: 100, truncated: true });

        const findings = constraintValidator.run({ schema, tableSamples: [userSample, postSample] });
        const fkFinding = findings.find((f) => f.metadata["kind"] === "fk");

        expect(fkFinding?.detail).toContain("capped");
    });

    it("does not flag a FK whose target row lies beyond a truncated target sample (Finding 3)", () => {
        expect.assertions(1);

        // users is truncated at cap 1: `u_beyond` is a real row that exists past
        // the sample window. posts.authorId points at it — a VALID reference that
        // must not be reported as dangling just because the target sample is
        // bounded.
        const userSample = makeSample("users", [{ _id: "u1", email: "a@b.com" }], { cap: 1, truncated: true });
        const postSample = makeSample("posts", [{ _id: "p1", authorId: "u_beyond", title: "Hello" }]);

        const findings = constraintValidator.run({ schema, tableSamples: [userSample, postSample] });

        expect(findings.filter((f) => f.metadata["kind"] === "fk")).toHaveLength(0);
    });

    it("checks a custom `references` column, not the target's _id set (Finding 4)", () => {
        expect.assertions(3);

        // posts.authorSlug references users.slug (not users._id). The valid row
        // resolves against the slug column; the dangling one does not. Comparing
        // against the _id set (the old bug) would flag BOTH as dangling.
        const refSchema = fromServerSchema(
            defineSchema({
                posts: defineTable({ authorSlug: v.string(), title: v.string() }).relations((r) => {
                    return { author: r.one("users", { field: "authorSlug", references: "slug" }) };
                }),
                users: defineTable({ slug: v.string() }).index("bySlug", ["slug"], { unique: true }),
            }),
        );
        const userSample = makeSample("users", [
            { _id: "u1", slug: "alice" },
            { _id: "u2", slug: "bob" },
        ]);
        const postSample = makeSample("posts", [
            { _id: "p1", authorSlug: "alice", title: "Valid" },
            { _id: "p2", authorSlug: "ghost", title: "Orphan" },
        ]);

        const findings = constraintValidator.run({ schema: refSchema, tableSamples: [userSample, postSample] });
        const fkFinding = findings.find((f) => f.metadata["kind"] === "fk" && f.metadata["table"] === "posts");

        // Exactly one dangling row (p2 → "ghost"); p1 → "alice" resolves.
        expect(fkFinding).toBeDefined();
        expect(fkFinding?.metadata["count"]).toBe(1);
        expect(fkFinding?.metadata["references"]).toBe("slug");
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

    describe("optional and nullable fields must not produce false-positive NOT NULL findings", () => {
        it("does not flag a null value in a v.optional() column", () => {
            expect.assertions(1);

            // `bio` is declared optional — a null/absent value is perfectly valid
            // and must not produce a constraint_validator:null finding.
            const schemaWithOptional = fromServerSchema(
                defineSchema({
                    profiles: defineTable({ bio: v.optional(v.string()), handle: v.string() }),
                }),
            );
            const sample = makeSample("profiles", [
                { _id: "p1", bio: null, handle: "alice" },
                { _id: "p2", handle: "bob" }, // bio absent
            ]);

            const findings = constraintValidator.run({ schema: schemaWithOptional, tableSamples: [sample] });

            expect(findings.filter((f) => f.metadata["kind"] === "null" && f.metadata["column"] === "bio")).toHaveLength(0);
        });

        it("does not flag a null value in a .nullable() column", () => {
            expect.assertions(1);

            // `deletedAt` uses .nullable() — null is a valid stored value and
            // must not trigger a NOT NULL finding.
            const schemaWithNullable = fromServerSchema(
                defineSchema({
                    items: defineTable({ deletedAt: v.number().nullable(), name: v.string() }),
                }),
            );
            const sample = makeSample("items", [
                { _id: "i1", deletedAt: null, name: "widget" },
                { _id: "i2", deletedAt: 1_700_000_000_000, name: "gadget" },
            ]);

            const findings = constraintValidator.run({ schema: schemaWithNullable, tableSamples: [sample] });

            expect(findings.filter((f) => f.metadata["kind"] === "null" && f.metadata["column"] === "deletedAt")).toHaveLength(0);
        });

        it("still flags null in a required (non-optional, non-nullable) column", () => {
            expect.assertions(1);

            // `name` is required — a null value is a genuine violation.
            const schemaWithRequired = fromServerSchema(
                defineSchema({
                    items: defineTable({ name: v.string() }),
                }),
            );
            const sample = makeSample("items", [{ _id: "i1", name: null }]);

            const findings = constraintValidator.run({ schema: schemaWithRequired, tableSamples: [sample] });

            expect(findings.filter((f) => f.metadata["kind"] === "null" && f.metadata["column"] === "name")).toHaveLength(1);
        });
    });
});
