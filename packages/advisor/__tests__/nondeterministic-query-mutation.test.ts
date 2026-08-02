import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorNondeterministicCall } from "../src";
import { fromServerSchema } from "../src";
import nondeterministicQueryMutation from "../src/lints/static/nondeterministic-query-mutation";

const schema = () =>
    fromServerSchema(
        defineSchema({
            messages: defineTable({ body: v.string() }),
        }),
    );

const run = (nondeterministicCalls?: AdvisorNondeterministicCall[]) => nondeterministicQueryMutation.run({ nondeterministicCalls, schema: schema() });

describe("nondeterministic_query_mutation", () => {
    it("finds nothing when no call evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        // A runtime caller (no codegen feeder) must not flag anything.
        expect(run()).toHaveLength(0);
    });

    // Issue #286: ordinary mutations don't replay on this (DO-backed) runtime —
    // an idempotency dedup returns the cached result rather than re-running the
    // handler, and an OCC conflict throws to the caller instead of an internal
    // retry — so a mutation handler runs at most once per logical write and
    // `Date.now()` inside one is stable. Confirmed 193 of 385 non-INFO findings
    // on one real codebase were this exact "stamp createdAt in a mutation"
    // pattern. Dropped to INFO (not silenced — a mutation dispatched from a
    // workflow step/queue consumer that itself replays is still a real
    // caveat, and the finding is the breadcrumb to it).
    it("drops Date.now() inside a mutation handler to INFO", () => {
        expect.assertions(2);

        const calls: AdvisorNondeterministicCall[] = [{ callee: "Date.now", exportName: "sendMessage", file: "messages", kind: "mutation", line: 12 }];
        const findings = run(calls);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "nondeterministic_query_mutation:messages:12:Date.now",
            categories: ["SCHEMA"],
            facing: "INTERNAL",
            level: "INFO",
            metadata: { callee: "Date.now", exportName: "sendMessage", file: "messages", kind: "mutation", line: 12 },
            name: "nondeterministic_query_mutation",
        });
    });

    // A query IS genuinely re-run by a live subscription whenever a table it
    // reads changes, so this half keeps its original WARN — the premise this
    // rule needs actually holds for queries.
    it("keeps Date.now() inside a query handler at WARN (a live subscription can re-run it)", () => {
        expect.assertions(2);

        const calls: AdvisorNondeterministicCall[] = [{ callee: "Date.now", exportName: "listMessages", file: "messages", kind: "query", line: 8 }];
        const findings = run(calls);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "nondeterministic_query_mutation:messages:8:Date.now",
            facing: "EXTERNAL",
            level: "WARN",
            metadata: { callee: "Date.now", exportName: "listMessages", file: "messages", kind: "query", line: 8 },
        });
    });

    it("does NOT flag Date.now() in an action (the feeder omits action handlers)", () => {
        expect.assertions(1);

        // The feeder records calls only inside query/mutation handlers, so an
        // action's Date.now never reaches the lint — modelled here by empty evidence.
        expect(run([])).toHaveLength(0);
    });

    it("passes for a clean query with no non-deterministic calls", () => {
        expect.assertions(1);

        // A clean query contributes no entries to the evidence array.
        expect(run([])).toHaveLength(0);
    });

    it("flags Math.random / crypto.randomUUID / fetch in query and mutation handlers", () => {
        expect.assertions(4);

        const calls: AdvisorNondeterministicCall[] = [
            { callee: "Math.random", exportName: "listMessages", file: "messages", kind: "query", line: 5 },
            { callee: "crypto.randomUUID", exportName: "sendMessage", file: "messages", kind: "mutation", line: 20 },
            { callee: "fetch", exportName: "sendMessage", file: "messages", kind: "mutation", line: 25 },
        ];
        const findings = run(calls);

        expect(findings).toHaveLength(3);
        expect(findings[0]!.cacheKey).toBe("nondeterministic_query_mutation:messages:5:Math.random");
        // eslint-disable-next-line no-secrets/no-secrets -- an advisor cache-key assertion, not a secret
        expect(findings[1]!.cacheKey).toBe("nondeterministic_query_mutation:messages:20:crypto.randomUUID");
        expect(findings[2]!.cacheKey).toBe("nondeterministic_query_mutation:messages:25:fetch");
    });

    it("produces distinct cacheKeys for two same-callee calls on the same source line", () => {
        expect.assertions(3);

        // `const pair = [Math.random(), Math.random()]` — both on line 7 with
        // the same callee.  Without a within-line discriminator they collapse to
        // one cacheKey and a single dismissal would silence both.
        const calls: AdvisorNondeterministicCall[] = [
            { callee: "Math.random", exportName: "makeId", file: "ids", kind: "mutation", line: 7 },
            { callee: "Math.random", exportName: "makeId", file: "ids", kind: "mutation", line: 7 },
        ];
        const findings = run(calls);

        expect(findings).toHaveLength(2);
        // First occurrence has no suffix; second gets `:2`.
        expect(findings[0]!.cacheKey).toBe("nondeterministic_query_mutation:ids:7:Math.random");
        expect(findings[1]!.cacheKey).toBe("nondeterministic_query_mutation:ids:7:Math.random:2");
    });
});
