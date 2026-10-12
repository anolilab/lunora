/**
 * The last-verified plan of each tenant script, kept where it outlives the
 * isolate (plan 476). The control plane is the only writer (see `plan-writer.ts`);
 * the dispatcher only reads, through {@link PlanReader}, and only when the
 * control plane cannot be asked.
 *
 * This module imports no Cloudflare types. The KV-backed implementation lives in
 * `plan-store-kv.ts`, so the resolver stays testable with a plain in-memory store.
 */

import type { PlanFacts } from "./plan-facts";
import { egressOf, normalizeFacts } from "./plan-facts";

/** What the control plane verified for one script, and when. */
export interface PlanRecord extends PlanFacts {
    plan: string;
    /** Epoch milliseconds of the control-plane read this record was built from. */
    verifiedAt: number;
}

/** The read side: all the dispatcher is given. Passing a reader is what keeps the dispatcher from writing. */
export interface PlanReader {
    /** The parsed record, or `undefined` when absent or malformed. A rejection means the store itself failed. */
    get: (scriptName: string) => Promise<PlanRecord | undefined>;
}

/** The write side, used only by the control plane's writer. */
export interface PlanStore extends PlanReader {
    delete: (scriptName: string) => Promise<void>;
    put: (scriptName: string, record: PlanRecord) => Promise<void>;
}

/**
 * Parse a record read back from storage, whatever the backend. Anything that is
 * not a well-formed, non-`unknown` record is `undefined`, which the resolver
 * treats as absent. An `unknown` answer is never persisted, so one found in
 * storage is not an answer. Every {@link PlanStore} reads through this, so the
 * resolver's own checks never depend on which backend it was given.
 */
export const parsePlanRecord = (data: unknown): PlanRecord | undefined => {
    if (typeof data !== "object" || data === null) {
        return undefined;
    }

    const body = data as Record<string, unknown>;
    const { plan, verifiedAt } = body;

    if (typeof plan !== "string" || plan === "unknown" || typeof verifiedAt !== "number" || !Number.isFinite(verifiedAt)) {
        return undefined;
    }

    if (body["protected"] !== undefined && typeof body["protected"] !== "boolean") {
        return undefined;
    }

    // A record whose egress policy does not validate is not a record: absent, so the resolver refuses.
    const egress = egressOf(body);

    if (egress.kind === "invalid") {
        return undefined;
    }

    return {
        ...normalizeFacts({ egress: egress.kind === "valid" ? egress.policy : undefined, plan, protected: body["protected"], recursion: body["recursion"] }),
        plan,
        verifiedAt,
    };
};

/**
 * Parse a stored value: JSON text as KV holds it, or `undefined` for an absent
 * key. Text that is not JSON reads as absent, like any malformed record.
 */
export const parseStoredRecord = (raw: null | string | undefined): PlanRecord | undefined => {
    if (raw === null || raw === undefined) {
        return undefined;
    }

    try {
        return parsePlanRecord(JSON.parse(raw));
    } catch {
        return undefined;
    }
};
