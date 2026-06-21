import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorHyperdriveCall } from "../src";
import { fromServerSchema } from "../src";
import hyperdriveOutsideAction from "../src/lints/static/hyperdrive-outside-action";

const schema = () =>
    fromServerSchema(
        defineSchema({
            customers: defineTable({ name: v.string() }),
        }),
    );

const run = (hyperdriveCalls?: AdvisorHyperdriveCall[]) => hyperdriveOutsideAction.run({ hyperdriveCalls, schema: schema() });

describe("hyperdrive_outside_action", () => {
    it("finds nothing when no access evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        // A runtime caller (no codegen feeder) must not flag anything.
        expect(run()).toHaveLength(0);
    });

    it("flags ctx.sql.query() inside a query handler", () => {
        expect.assertions(2);

        const calls: AdvisorHyperdriveCall[] = [{ callee: "ctx.sql.query", exportName: "listCustomers", file: "customers", kind: "query", line: 7 }];
        const findings = run(calls);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "hyperdrive_outside_action:customers:7:ctx.sql.query",
            categories: ["SCHEMA"],
            level: "WARN",
            metadata: { callee: "ctx.sql.query", exportName: "listCustomers", file: "customers", kind: "query", line: 7 },
            name: "hyperdrive_outside_action",
        });
    });

    it("flags ctx.sql inside a mutation handler", () => {
        expect.assertions(1);

        const calls: AdvisorHyperdriveCall[] = [{ callee: "ctx.sql", exportName: "syncCustomer", file: "customers", kind: "mutation", line: 14 }];

        expect(run(calls)).toHaveLength(1);
    });

    it("is clean for an action (the feeder omits action handlers)", () => {
        expect.assertions(1);

        // The feeder records accesses only inside query/mutation handlers, so a
        // ctx.sql call in an action never reaches the lint — modelled here by empty evidence.
        expect(run([])).toHaveLength(0);
    });
});
