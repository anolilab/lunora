import { describe, expect, it } from "vitest";

import { deriveChecklistSteps } from "../lunora/onboarding";

/**
 * The onboarding checklist's derivation (GAPS.md ring 3 #5). The steps are
 * computed from real rows rather than stored, so these are the rules that decide
 * what a user is told to do next.
 */
describe(deriveChecklistSteps, () => {
    it("starts with everything undone for a fresh org", () => {
        const steps = deriveChecklistSteps({ deployments: [], keys: [], projects: 0 });

        expect(steps.map((step) => step.done)).toStrictEqual([false, false, false, false]);
    });

    it("orders the steps by dependency, so the first undone one is the next action", () => {
        const steps = deriveChecklistSteps({ deployments: [], keys: [], projects: 0 });

        expect(steps.map((step) => step.id)).toStrictEqual(["project", "key", "deploy", "live"]);
    });

    /**
     * A revoked key must not tick the "issue a deploy key" step. The step means
     * "you can deploy", and a revoked key cannot — ticking it would send someone
     * to a CI run that fails authentication with the checklist saying they are set.
     */
    it("does not count a revoked key as having a deploy key", () => {
        const steps = deriveChecklistSteps({ deployments: [], keys: [{ revokedAt: 1 }], projects: 1 });

        expect(steps.find((step) => step.id === "key")?.done).toBe(false);
        expect(deriveChecklistSteps({ deployments: [], keys: [{ revokedAt: 1 }, {}], projects: 1 }).find((step) => step.id === "key")?.done).toBe(true);
    });

    /**
     * "Deployed" and "live" are different facts: a deployment that failed still
     * proves the pipeline ran, but nothing is serving. Collapsing them would tell
     * someone whose deploy failed that they were finished.
     */
    it("separates having deployed from being live", () => {
        const failed = deriveChecklistSteps({ deployments: [{ status: "failed" }], keys: [{}], projects: 1 });

        expect(failed.find((step) => step.id === "deploy")?.done).toBe(true);
        expect(failed.find((step) => step.id === "live")?.done).toBe(false);
    });

    it("completes once a deployment is live", () => {
        const steps = deriveChecklistSteps({ deployments: [{ status: "superseded" }, { status: "live" }], keys: [{}], projects: 1 });

        expect(steps.every((step) => step.done)).toBe(true);
    });
});
