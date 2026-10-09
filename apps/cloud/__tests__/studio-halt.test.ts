import { describe, expect, it } from "vitest";

import type { HaltStatusView, HaltView } from "../src/client/halt";
import { confirmsHalt, describeHaltReason, emergencyStopActions, HALT_CONFIRMATION, HALT_STATE, haltOnSuspensionCopy } from "../src/client/halt";

/**
 * The emergency-stop card's decisions (`src/client/halt.ts`), tested without a
 * DOM: what it offers when, why a resume waits for a suspension, the typed
 * confirmation a stop takes, and how each halt reads. The card only renders these.
 */

const halt = (overrides: Partial<HaltView> = {}): HaltView => {
    return {
        alias: "acme",
        attempts: 0,
        haltedBy: "usr_1",
        kind: "production",
        projectId: "p_1",
        reason: "manual",
        requestedAt: 1,
        source: "manual",
        state: "halted",
        ...overrides,
    };
};

const status = (overrides: Partial<HaltStatusView> = {}): HaltStatusView => {
    return { autoHalted: false, haltable: 0, halts: [], haltOnSuspension: true, supportHalted: false, unsupported: [], ...overrides };
};

describe(emergencyStopActions, () => {
    it("offers a stop while there are running projects, and no resume with nothing stopped", () => {
        expect(emergencyStopActions(status({ haltable: 2 }))).toStrictEqual({ canHalt: true, canResume: false });
        expect(emergencyStopActions(status())).toStrictEqual({ canHalt: false, canResume: false });
    });

    it("offers a resume for stopped projects, but not for ones already resuming", () => {
        expect(emergencyStopActions(status({ halts: [halt()] }))).toStrictEqual({ canHalt: false, canResume: true });
        expect(emergencyStopActions(status({ halts: [halt({ state: "resuming" })] }))).toStrictEqual({ canHalt: false, canResume: false });
    });

    it("says why a resume waits while the suspension holds the projects, and how to lift it", () => {
        const actions = emergencyStopActions(status({ autoHalted: true, halts: [halt({ source: "suspension" })], suspendedReason: "spend-cap" }));

        expect(actions.canResume).toBe(false);
        expect(actions.resumeBlocked).toMatch(/suspended \(spend-cap\).*until the suspension lifts/u);
        expect(actions.resumeBlocked).toMatch(/Stop projects on suspension/u);
    });
});

describe("support's stop in the card (L3)", () => {
    it("offers neither stop nor resume while support holds the organization, and says who lifts it", () => {
        const actions = emergencyStopActions(status({ haltable: 1, halts: [halt({ source: "support" })], supportHalted: true }));

        expect(actions).toMatchObject({ canHalt: false, canResume: false });
        expect(actions.resumeBlocked).toMatch(/Only support can resume them/u);
    });

    it("offers a resume only for the stops an owner or admin may lift", () => {
        expect(emergencyStopActions(status({ halts: [halt({ source: "support" })] })).canResume).toBe(false);
        expect(emergencyStopActions(status({ halts: [halt({ source: "support" }), halt({ alias: "shop" })] })).canResume).toBe(true);
    });
});

describe(confirmsHalt, () => {
    it("takes the exact word, surrounding space aside", () => {
        expect(confirmsHalt(HALT_CONFIRMATION)).toBe(true);
        expect(confirmsHalt(` ${HALT_CONFIRMATION} `)).toBe(true);
        expect(confirmsHalt("halt")).toBe(false);
        expect(confirmsHalt("")).toBe(false);
    });
});

describe("how a halt reads", () => {
    it.each([
        ["suspension", "spend-cap", "spend cap reached"],
        ["suspension", "overage", "prepaid credits ran out"],
        ["manual", "manual", "stopped by hand"],
        ["manual", "support", "stopped by Lunora support"],
        ["support", "support", "stopped by Lunora support"],
    ] as const)("names a %s halt for %s as %j", (source, reason, expected) => {
        expect(describeHaltReason({ reason, source })).toBe(expected);
    });

    it("gives every converge state a chip and an explanation, a stopped project in the danger tone", () => {
        expect(HALT_STATE.halted.tone).toBe("danger");
        expect(Object.values(HALT_STATE).every((entry) => entry.description.length > 0 && entry.label.length > 0)).toBe(true);
    });

    it("explains the setting both ways, including that a failed payment never stops projects", () => {
        expect(haltOnSuspensionCopy(true)).toMatch(/failed payment never stops them/u);
        expect(haltOnSuspensionCopy(false)).toMatch(/keeps running and billing/u);
    });
});
