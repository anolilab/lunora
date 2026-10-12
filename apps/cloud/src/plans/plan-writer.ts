import type { PlanFacts } from "./plan-facts";
import { normalizeFacts, sameFacts, UNAVAILABLE_PLAN } from "./plan-facts";
import type { PlanRecord, PlanStore } from "./plan-store";

/**
 * The control plane's writer for the stored plan records (plan 476 §4.1). Pure
 * over its ports: the store and the authoritative facts. It imports no Cloudflare
 * types and no database, so the caller decides both.
 *
 * It is not a change-log consumer. Each pass takes a script and asks the question
 * the dispatcher will ask: what do the facts say now, and does the stored record
 * agree? A write that failed, a fact change that was never published, and a
 * record past its refresh age all look the same from here: the record disagrees
 * with the facts or is due. So nothing is marked dirty and nothing relies on the
 * record's age alone, and the next pass retries whatever is still wrong.
 */

/** A record older than this is re-verified by the control plane's hourly sweep (plan 476 §4.1). */
export const PLAN_REFRESH_AFTER_MS = 20 * 3_600_000;

/** The current facts for one script, as the control plane's own plan lookup answers them. */
export type FactsOf = (scriptName: string) => Promise<PlanFacts>;

export interface RefreshOutcome {
    /** Scripts whose record was removed: their facts are `unknown` or absent now. */
    deleted: number;
    /** Scripts whose facts could not be read or whose write threw; the next pass retries them. */
    failed: string[];
    /** Scripts whose record was written: new, changed, or past the refresh age. */
    written: number;
}

/**
 * The record the control plane should hold for a script's facts, or `undefined`
 * when the facts are `unknown` or absent. The writer must then DELETE any record
 * already held: a script that stops being a tenant must not keep a servable
 * record for the staleness bound.
 */
export const planRecordFor = (facts: PlanFacts, now: number): PlanRecord | undefined => {
    if (facts.plan === undefined || facts.plan === "unknown" || facts.plan === UNAVAILABLE_PLAN) {
        return undefined;
    }

    return { ...normalizeFacts(facts), plan: facts.plan, verifiedAt: now };
};

/** Whether the hourly sweep should rewrite a record: missing, or verified more than {@link PLAN_REFRESH_AFTER_MS} ago. */
export const needsRefresh = (record: PlanRecord | undefined, now: number): boolean => record === undefined || now - record.verifiedAt > PLAN_REFRESH_AFTER_MS;

/**
 * Bring each script's stored record in line with its current facts. A script
 * with no servable facts loses its record, so a script that stopped being a
 * tenant cannot keep one. A failed lookup or write is counted, never thrown, so
 * one bad script cannot stop the rest.
 *
 * Writes only when the record is missing, differs from the facts, or is older
 * than the refresh age. A steady, unchanged tenant is therefore rewritten about
 * once a day, and nothing is written on a tick where nothing needs it.
 */
export const refreshPlanRecords = async (
    scriptNames: ReadonlyArray<string>,
    options: { facts: FactsOf; now: () => number; store: PlanStore },
): Promise<RefreshOutcome> => {
    const outcome: RefreshOutcome = { deleted: 0, failed: [], written: 0 };

    for (const scriptName of scriptNames) {
        try {
            const readAt = options.now();
            // eslint-disable-next-line no-await-in-loop -- one script at a time keeps the write rate bounded
            const desired = planRecordFor(await options.facts(scriptName), readAt);
            // eslint-disable-next-line no-await-in-loop -- as above
            const stored = await options.store.get(scriptName);

            if (desired === undefined) {
                if (stored !== undefined) {
                    // eslint-disable-next-line no-await-in-loop -- as above
                    await options.store.delete(scriptName);
                    outcome.deleted += 1;
                }

                continue;
            }

            if (stored !== undefined && sameFacts(stored, desired) && !needsRefresh(stored, options.now())) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- as above
            await options.store.put(scriptName, desired);
            outcome.written += 1;
        } catch {
            outcome.failed.push(scriptName);
        }
    }

    return outcome;
};
