import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorR2sqlCall } from "../src";
import { fromServerSchema } from "../src";
import r2sqlOutsideAction from "../src/lints/static/r2sql-outside-action";

const schema = () =>
    fromServerSchema(
        defineSchema({
            customers: defineTable({ name: v.string() }),
        }),
    );

const run = (r2sqlCalls?: AdvisorR2sqlCall[]) => r2sqlOutsideAction.run({ r2sqlCalls, schema: schema() });

describe("r2sql_outside_action", () => {
    it("finds nothing when no access evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        // A runtime caller (no codegen feeder) must not flag anything.
        expect(run()).toHaveLength(0);
    });

    it("flags ctx.r2sql.from() inside a query handler", () => {
        expect.assertions(2);

        const calls: AdvisorR2sqlCall[] = [{ callee: "ctx.r2sql.from", exportName: "topRegions", file: "analytics", kind: "query", line: 7 }];
        const findings = run(calls);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "r2sql_outside_action:analytics:7:ctx.r2sql.from",
            categories: ["SCHEMA"],
            level: "WARN",
            metadata: { callee: "ctx.r2sql.from", exportName: "topRegions", file: "analytics", kind: "query", line: 7 },
            name: "r2sql_outside_action",
        });
    });

    it("flags ctx.r2sql.query inside a mutation handler", () => {
        expect.assertions(1);

        const calls: AdvisorR2sqlCall[] = [{ callee: "ctx.r2sql.query", exportName: "syncReport", file: "analytics", kind: "mutation", line: 14 }];

        expect(run(calls)).toHaveLength(1);
    });

    it("is clean for an action (the feeder omits action handlers)", () => {
        expect.assertions(1);

        // The feeder records accesses only inside query/mutation handlers, so a
        // ctx.r2sql call in an action never reaches the lint — modelled here by empty evidence.
        expect(run([])).toHaveLength(0);
    });
});
