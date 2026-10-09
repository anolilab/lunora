import type { ReturnOf } from "@lunora/client";

import type { api } from "../../lunora/_generated/api.js";

/**
 * Pure decisions of the emergency-stop card (`./EmergencyStopCard.tsx`): how
 * each halted alias reads, which actions the card offers, and the typed
 * confirmation a stop takes. Kept out of the component so each decision is
 * testable in node, without a DOM.
 */

export type HaltStatusView = ReturnOf<typeof api.halts.status>;
export type HaltView = HaltStatusView["halts"][number];

/** What the operator types to confirm a stop: a deliberate word, not a click. */
export const HALT_CONFIRMATION = "HALT";

/** The status-chip tones `StatusBadge` knows. */
export type HaltTone = "danger" | "neutral" | "warning";

/** How each converge state reads. */
export const HALT_STATE: Readonly<Record<HaltView["state"], { description: string; label: string; tone: HaltTone }>> = {
    halted: { description: "Stopped. The stub is on the Worker; data is kept and Durable Object alarms are parked.", label: "halted", tone: "danger" },
    halting: { description: "Stopping. The stub converges onto the Worker within a minute or two.", label: "stopping", tone: "warning" },
    resuming: { description: "Resuming. The live release converges back onto the Worker within a minute or two.", label: "resuming", tone: "neutral" },
};

/** Why an alias is halted, in words. */
export const describeHaltReason = (halt: Pick<HaltView, "reason" | "source">): string => {
    if (halt.source === "suspension") {
        return halt.reason === "overage" ? "prepaid credits ran out" : "spend cap reached";
    }

    return halt.reason === "support" ? "stopped by Lunora support" : "stopped by hand";
};

/** What the card offers right now. */
export interface EmergencyStopActions {
    /** Live projects a stop would reach. */
    canHalt: boolean;
    /** Halted projects a resume would restore. */
    canResume: boolean;
    /** Why a resume is not offered while there are halted projects; absent when it is. */
    resumeBlocked?: string;
}

export const emergencyStopActions = (status: Pick<HaltStatusView, "autoHalted" | "haltable" | "halts" | "suspendedReason">): EmergencyStopActions => {
    const resumable = status.halts.some((halt) => halt.state !== "resuming");

    if (resumable && status.autoHalted) {
        return {
            canHalt: status.haltable > 0,
            canResume: false,
            resumeBlocked: `The organization is suspended (${status.suspendedReason ?? "suspended"}), so its projects stay stopped until the suspension lifts. Raise the cap or add credits, or turn off "Stop projects on suspension" below.`,
        };
    }

    return { canHalt: status.haltable > 0, canResume: resumable };
};

/** Whether the typed confirmation matches. */
export const confirmsHalt = (typed: string): boolean => typed.trim() === HALT_CONFIRMATION;

/** The setting's sentence, either way. */
export const haltOnSuspensionCopy = (enabled: boolean): string =>
    enabled
        ? "On: when the spend cap is reached or prepaid credits run out, every project is stopped as well as suspended, so code that is already running stops billing. Lifting the suspension resumes them. A failed payment never stops them."
        : "Off: a spend-cap or credits suspension blocks new requests, but code that is already running — Durable Object alarms included — keeps running and billing.";
