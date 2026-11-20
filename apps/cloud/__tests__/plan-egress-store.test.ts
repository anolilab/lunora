import { describe, expect, it, vi } from "vitest";

import type { EgressPolicy } from "../src/egress/policy";
import { sameFacts, toScriptFacts } from "../src/plans/plan-facts";
import { createPlanResolver, UNAVAILABLE_PLAN } from "../src/plans/plan-resolver";
import { parsePlanRecord } from "../src/plans/plan-store";
import { planRecordFor } from "../src/plans/plan-writer";
import { down, spiedStore, T0 } from "./_helpers/plan-fixtures";

/**
 * Egress (plan 477) must survive every place base rebuilds plan facts: the control-plane answer, the stored
 * record an outage falls back to, and the writer that persists it. A policy that is dropped anywhere fails
 * open, so each hop has its own case.
 */

const POLICY: EgressPolicy = { mode: "enforce", origins: ["https://api.example.com"], v: 1 };

/** The facts of a well-formed answer; a malformed one fails the test, not the assertion. */
const factsOf = (body: unknown) => {
    const facts = toScriptFacts(body);

    if (facts === undefined) {
        throw new Error("the answer was malformed");
    }

    return facts;
};

describe("egress through the plan facts", () => {
    it("carries a valid policy in the control-plane answer", () => {
        const facts = factsOf({ egress: POLICY, plan: "pro" });

        expect(facts.plan).toBe("pro");
        expect(facts.egress?.mode).toBe("enforce");
    });

    it("refuses an invalid policy in the control-plane answer rather than dropping it", () => {
        expect(toScriptFacts({ egress: { mode: "nope", v: 1 }, plan: "pro" })).toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("refuses a stored record whose policy does not validate, so the resolver treats it as absent", () => {
        expect(parsePlanRecord({ egress: { mode: "nope", v: 1 }, plan: "pro", verifiedAt: T0 })).toBeUndefined();
    });

    it("keeps a valid policy on a stored record", () => {
        expect(parsePlanRecord({ egress: POLICY, plan: "pro", verifiedAt: T0 })?.egress?.origins).toStrictEqual(["https://api.example.com"]);
    });

    it("persists the policy in the record the writer builds", () => {
        expect(planRecordFor(factsOf({ egress: POLICY, plan: "pro" }), T0)?.egress?.origins).toStrictEqual(["https://api.example.com"]);
    });

    it("rewrites the record when only the policy changes", () => {
        const before = factsOf({ egress: POLICY, plan: "pro" });
        const after = factsOf({ egress: { ...POLICY, origins: ["https://other.example.com"] }, plan: "pro" });

        expect(sameFacts(before, after)).toBe(false);
    });

    it("serves the stored policy during an outage, so the dispatcher still sends it", async () => {
        let clock = T0;
        const store = spiedStore({ "acme-app": { egress: POLICY, plan: "pro", verifiedAt: T0 } });
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(() => down()),
            now: () => clock,
            planStore: store,
        });

        clock = T0 + 60_000;
        const facts = await resolve("acme-app");

        expect(facts.plan).toBe("pro");
        expect(facts.egress?.origins).toStrictEqual(["https://api.example.com"]);
    });
});
