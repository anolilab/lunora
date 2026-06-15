import { defineSchema, defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";
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

    it("flags Date.now() inside a mutation handler", () => {
        expect.assertions(2);

        const calls: AdvisorNondeterministicCall[] = [{ callee: "Date.now", exportName: "sendMessage", file: "messages", kind: "mutation", line: 12 }];
        const findings = run(calls);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "nondeterministic_query_mutation:messages:12:Date.now",
            categories: ["SCHEMA"],
            level: "WARN",
            metadata: { callee: "Date.now", exportName: "sendMessage", file: "messages", kind: "mutation", line: 12 },
            name: "nondeterministic_query_mutation",
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
});
