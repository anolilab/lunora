import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorSchema } from "../src";
import { circularFk, fromServerSchema } from "../src";

const run = (schema: ReturnType<typeof defineSchema>) => circularFk.run({ schema: fromServerSchema(schema) });

describe("circular_fk", () => {
    it("detects a direct two-table cycle (A → B → A)", () => {
        expect.assertions(3);

        const schema = defineSchema({
            comments: defineTable({ postId: v.id("posts") }).relations((r) => {
                return { post: r.one("posts", { field: "postId" }) };
            }),
            posts: defineTable({ commentId: v.id("comments") }).relations((r) => {
                return { comment: r.one("comments", { field: "commentId" }) };
            }),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect(findings[0]?.name).toBe("circular_fk");
        // The cycle contains both tables.
        expect(findings[0]?.metadata["tables"]).toEqual(expect.arrayContaining(["comments", "posts"]));
    });

    it("detects a three-table cycle (A → B → C → A)", () => {
        expect.assertions(2);

        const schema = defineSchema({
            // a.bId → b, b.cId → c, c.aId → a
            a: defineTable({ bId: v.id("b") }).relations((r) => {
                return { b: r.one("b", { field: "bId" }) };
            }),
            b: defineTable({ cId: v.id("c") }).relations((r) => {
                return { c: r.one("c", { field: "cId" }) };
            }),
            c: defineTable({ aId: v.id("a") }).relations((r) => {
                return { a: r.one("a", { field: "aId" }) };
            }),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect((findings[0]?.metadata["cycle"] as string[]).toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b", "c"]);
    });

    it("reports each cycle exactly once (idempotent under any DFS entry order)", () => {
        expect.assertions(1);

        // The same two-table cycle is reachable from both tables — must not double-report.
        const schema = defineSchema({
            comments: defineTable({ postId: v.id("posts") }).relations((r) => {
                return { post: r.one("posts", { field: "postId" }) };
            }),
            posts: defineTable({ commentId: v.id("comments") }).relations((r) => {
                return { comment: r.one("comments", { field: "commentId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(1);
    });

    it("passes when the schema has no cycles (linear FK chain)", () => {
        expect.assertions(1);

        const schema = defineSchema({
            comments: defineTable({ postId: v.id("posts") }).relations((r) => {
                return { post: r.one("posts", { field: "postId" }) };
            }),
            posts: defineTable({ authorId: v.id("users") }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ name: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("ignores `many` relations (they don't own the FK column)", () => {
        expect.assertions(1);

        // users.posts is a `many` back-reference; the FK lives on posts.authorId.
        // Only posts → users is a directed edge; there's no cycle.
        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users") }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("does not flag a self-referential FK (tree/hierarchy is intentional)", () => {
        expect.assertions(1);

        // `nodes.parentId → nodes` is the canonical tree shape — a self-loop must
        // not be reported as a circular-FK hazard.
        const schema = defineSchema({
            nodes: defineTable({ parentId: v.id("nodes") }).relations((r) => {
                return { parent: r.one("nodes", { field: "parentId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("passes on an empty schema", () => {
        expect.assertions(1);

        expect(circularFk.run({ schema: { tables: [] } })).toHaveLength(0);
    });

    it("finds nothing when no `one` relations are declared", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }),
            users: defineTable({ name: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("populates cacheKey, detail, and metadata correctly", () => {
        expect.assertions(4);

        const schema = defineSchema({
            comments: defineTable({ postId: v.id("posts") }).relations((r) => {
                return { post: r.one("posts", { field: "postId" }) };
            }),
            posts: defineTable({ commentId: v.id("comments") }).relations((r) => {
                return { comment: r.one("comments", { field: "commentId" }) };
            }),
        });

        const [finding] = run(schema);

        expect(finding?.cacheKey).toMatch(/^circular_fk:/);
        expect(finding?.detail).toContain("Circular foreign-key dependency detected");
        expect(finding?.metadata["path"]).toContain("→");
        expect(Array.isArray(finding?.metadata["cycle"])).toBe(true);
    });

    it("detects overlapping cycles that share an interior node (chord / diamond pattern)", () => {
        expect.assertions(2);

        // Graph: A→B, A→C, B→D, C→D, D→A
        // Two distinct simple cycles share node D:
        //   A → B → D → A
        //   A → C → D → A
        // The old global `visited` set would detect the first and then skip D on
        // the second path because D was already marked visited, silently dropping
        // the second cycle.
        const schema = defineSchema({
            a: defineTable({ bId: v.id("b"), cId: v.id("c") }).relations((r) => {
                return {
                    b: r.one("b", { field: "bId" }),
                    c: r.one("c", { field: "cId" }),
                };
            }),
            b: defineTable({ dId: v.id("d") }).relations((r) => {
                return { d: r.one("d", { field: "dId" }) };
            }),
            c: defineTable({ dId: v.id("d") }).relations((r) => {
                return { d: r.one("d", { field: "dId" }) };
            }),
            d: defineTable({ aId: v.id("a") }).relations((r) => {
                return { a: r.one("a", { field: "aId" }) };
            }),
        });

        const findings = run(schema);

        // Both distinct cycles must be reported.
        expect(findings.length).toBeGreaterThanOrEqual(2);

        const cycles = findings.map((f) => (f.metadata["cycle"] as string[]).toSorted((x, y) => x.localeCompare(y)));

        // One cycle covers {a, b, d} and the other covers {a, c, d}.
        expect(cycles).toEqual(expect.arrayContaining([expect.arrayContaining(["a", "b", "d"]), expect.arrayContaining(["a", "c", "d"])]));
    });

    it("stays fast on a large acyclic reconverging FK graph (no exponential path blow-up)", () => {
        expect.assertions(1);

        // A forward-only diamond chain: t_i → t_{i+1} and t_i → t_{i+2}. Every
        // edge points at a higher index, so the graph is strictly acyclic, but
        // the number of distinct simple *paths* from t0 grows like Fibonacci(n).
        // A naive enumerate-all-paths DFS walks every one of them and would take
        // minutes here (and hang codegen); Johnson's algorithm blocks exhausted
        // subtrees and returns immediately. This test would time out under the
        // old implementation. Built as an AdvisorSchema directly to keep the graph
        // construction (and the forward-only edges) explicit.
        const n = 40;
        const tables: AdvisorSchema["tables"][number][] = [];

        for (let i = 0; i < n; i += 1) {
            const relations: AdvisorSchema["tables"][number]["relations"][number][] = [];

            if (i + 1 < n) {
                relations.push({ field: "next1", kind: "one", name: "a", references: "_id", table: `t${(i + 1).toString()}` });
            }

            if (i + 2 < n) {
                relations.push({ field: "next2", kind: "one", name: "b", references: "_id", table: `t${(i + 2).toString()}` });
            }

            tables.push({ fields: [], indexes: [], name: `t${i.toString()}`, relations });
        }

        // Acyclic ⇒ zero findings, and it must return well within the test timeout.
        expect(circularFk.run({ schema: { tables } })).toHaveLength(0);
    });
});
