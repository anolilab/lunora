import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { bench, describe } from "vitest";

import type { Lint } from "../src";
import { ALL_LINTS, fromServerSchema, runAdvisor, STATIC_LINTS } from "../src";

/*
 * `runAdvisor` fans a fixed lint set over one context and flattens the findings.
 * It runs on every codegen pass (the static tier) and behind the studio Advisors
 * pages, so its cost is roughly `lint count x schema size` — and the lint count
 * only ever grows.
 *
 * What these benches are for:
 *
 *  - `STATIC_LINTS` is the build-time tier. Its number is the one that shows up
 *    as codegen latency, so it is benched at three schema sizes to make the
 *    scaling visible rather than a single opaque figure.
 *  - `ALL_LINTS` adds the runtime tier. Those lints no-op without runtime
 *    evidence in the context, so the gap between the two is the fixed dispatch
 *    overhead of running a lint that has nothing to look at.
 *  - The single-lint benches isolate two rules with genuinely super-linear
 *    shapes — `circular_fk` walks the relation graph and `duplicate_index`
 *    compares index definitions pairwise — so a regression in either is not
 *    hidden inside the whole-suite total.
 *
 * The context carries only `schema`: every evidence-fed lint (SSRF, auth, mail,
 * container, …) reads an optional field a codegen feeder supplies, so this
 * measures the schema-driven tier plus each other lint's early-out.
 */

// ---- Fixtures ------------------------------------------------------------

/**
 * Build a realistically-shaped schema of `size` tables: a couple of shared
 * parent tables (`users`, `orgs`) that most tables point at, plus a short
 * three-table cycle so `circular_fk` has something real to report.
 *
 * The fan-onto-shared-parents shape is deliberate — it is what actual schemas
 * look like, and it is also the shape that used to make a naive path-DFS
 * `circular_fk` blow up exponentially despite being acyclic. Benching a ring of
 * every table instead would put one lint's worst case in front of the whole
 * suite's number and misrepresent what codegen actually pays.
 */
const buildSchema = (size: number) => {
    // Loosely typed accumulator: `defineTable` returns a builder generic in its
    // own shape, so a shared annotation across differently-shaped tables cannot
    // be written without erasing that. The cast lands once, at `defineSchema`.
    const tables: Record<string, unknown> = {
        orgs: defineTable({ name: v.string(), tier: v.string() }).index("by_name", ["name"]),
        users: defineTable({ email: v.string(), orgId: v.id("orgs") })
            .index("by_email", ["email"])
            .relations((r) => {
                return { org: r.one("orgs", { field: "orgId" }) };
            }),
    };

    for (let index = 0; index < size; index += 1) {
        tables[`table${String(index)}`] = defineTable({
            body: v.string(),
            createdAt: v.number(),
            ownerId: v.id("users"),
            orgId: v.id("orgs"),
            priority: v.number(),
            title: v.string(),
        })
            .index("by_title", ["title"])
            .index("by_priority", ["priority", "createdAt"])
            .relations((r) => {
                return { org: r.one("orgs", { field: "orgId" }), owner: r.one("users", { field: "ownerId" }) };
            });
    }

    // One genuine three-table cycle, independent of the fan-out above.
    tables["cycleA"] = defineTable({ bId: v.id("cycleB") }).relations((r) => {
        return { b: r.one("cycleB", { field: "bId" }) };
    });
    tables["cycleB"] = defineTable({ cId: v.id("cycleC") }).relations((r) => {
        return { c: r.one("cycleC", { field: "cId" }) };
    });
    tables["cycleC"] = defineTable({ aId: v.id("cycleA") }).relations((r) => {
        return { a: r.one("cycleA", { field: "aId" }) };
    });

    return fromServerSchema(defineSchema(tables as never));
};

/**
 * The pathological shape for cycle enumeration: every table in one long FK ring.
 * Benched separately and explicitly, so `circular_fk`'s worst case is visible
 * without being mistaken for the cost of a normal schema.
 */
const buildRingSchema = (size: number) => {
    const tables: Record<string, unknown> = {};

    for (let index = 0; index < size; index += 1) {
        const next = `ring${String((index + 1) % size)}`;

        tables[`ring${String(index)}`] = defineTable({ nextId: v.id(next), title: v.string() }).relations((r) => {
            return { next: r.one(next, { field: "nextId" }) };
        });
    }

    return fromServerSchema(defineSchema(tables as never));
};

const small = { schema: buildSchema(5) };
const medium = { schema: buildSchema(25) };
const large = { schema: buildSchema(100) };
const ring = { schema: buildRingSchema(100) };

/**
 * Resolve a lint by name, throwing when it is gone.
 *
 * Deliberately not `find(...)?.run(...)`: if a lint is renamed or split, the
 * optional chain would turn its bench into a no-op that reports a near-zero
 * time — which reads on a CodSpeed dashboard as a spectacular improvement. A
 * perf guard that fails silently into "everything got faster" is worse than no
 * guard, so this fails the bench run instead.
 */
const lintNamed = (name: string): Lint => {
    const lint = STATIC_LINTS.find((candidate) => candidate.name === name);

    if (lint === undefined) {
        throw new Error(`bench fixture is stale: no static lint named "${name}"`);
    }

    return lint;
};

const circularFkLint = lintNamed("circular_fk");
const duplicateIndexLint = lintNamed("duplicate_index");

// ---- Benches -------------------------------------------------------------

describe("runAdvisor — static tier", () => {
    bench("5-table schema", () => {
        runAdvisor(small, { lints: STATIC_LINTS, source: "static" });
    });

    bench("25-table schema", () => {
        runAdvisor(medium, { lints: STATIC_LINTS, source: "static" });
    });

    bench("100-table schema", () => {
        runAdvisor(large, { lints: STATIC_LINTS, source: "static" });
    });
});

describe("runAdvisor — every lint, 25-table schema", () => {
    bench("ALL_LINTS (runtime lints no-op without evidence)", () => {
        runAdvisor(medium, { lints: ALL_LINTS });
    });

    bench("STATIC_LINTS only", () => {
        runAdvisor(medium, { lints: STATIC_LINTS, source: "static" });
    });
});

describe("individual lints with super-linear shapes — 100-table schema", () => {
    bench("circular_fk (relation-graph walk, realistic fan-out)", () => {
        circularFkLint.run(large);
    });

    bench("circular_fk (worst case: every table in one FK ring)", () => {
        circularFkLint.run(ring);
    });

    bench("duplicate_index (pairwise index compare)", () => {
        duplicateIndexLint.run(large);
    });
});
