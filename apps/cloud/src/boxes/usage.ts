/**
 * The box usage path (plan 458 G15, W6): a box's `report` frames become
 * `platformUsage { kind: "requests" }` rows, one per alias that served
 * requests in the window, attributed to that alias's live deployment.
 *
 * Displayed, never billed (D12): the customer has root on the box, so its
 * counts are not billing evidence. Every row carries `boxId`, which is what
 * keeps it out of the spend cap, the overage debit and the invoice summary
 * (`isBillableUsage` in `src/billing/usage.ts`).
 *
 * A report is untrusted input (plan 458 §8). Only aliases of projects placed on
 * THIS box, in its organization, are counted; a window too long, too old or in
 * the future is dropped; and a window already recorded for this box is never
 * counted twice — a replayed report, or one resent after a reconnect, is a no-op.
 * What a report costs is bounded by the box's own projects: their aliases are
 * read once, and every other alias in it is dropped without a read. The session
 * (`session-do.ts`) also remembers each window it processed, rows or not, and
 * caps how many reports a socket may send.
 */
import type { ReportMessage } from "@lunora/hostd/protocol";

import type { ControlPlaneStore } from "../d1-store";

/** The longest window one report may cover. */
export const MAX_REPORT_WINDOW_MS = 60 * 60 * 1000;

/** How old a window may be and still be recorded — a box's backlog after a reconnect. */
export const MAX_REPORT_AGE_MS = 24 * 60 * 60 * 1000;

/** How far ahead of the control plane's clock a window may end. */
export const MAX_REPORT_SKEW_MS = 5 * 60 * 1000;

/** What recording one report did. */
export type ReportOutcome = { dropped: "duplicate" | "out-of-range" } | { recorded: number };

/** Epoch ms of the first instant of `at`'s UTC month — the `platformUsage` period bucket. */
export const periodStartOf = (at: number): number => {
    const date = new Date(at);

    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/**
 * The live deployment of every alias this box may report on: the aliases of
 * the projects placed on `box`, in its organization. Read once per report, so
 * the cost of a report is bounded by the box's own projects — never by how
 * many aliases the box chose to name in it.
 */
const liveAliasesOn = async (database: ControlPlaneStore, box: { _id: string; organizationId: string }): Promise<Map<string, string>> => {
    const { page: projects } = await database.findMany("projects", { where: { boxId: box._id, organizationId: box.organizationId } });
    const live = new Map<string, string>();

    for (const project of projects as { _id: string }[]) {
        // eslint-disable-next-line no-await-in-loop -- one read per project placed on this box; an org's handful
        const { page } = await database.findMany("deployments", { where: { projectId: project._id, status: "live" } }); // secret-scanner:allow -- domain field name

        for (const deployment of page as { _id: string; alias?: null | string }[]) {
            if (deployment.alias != null && !live.has(deployment.alias)) {
                live.set(deployment.alias, deployment._id);
            }
        }
    }

    return live;
};

/** Record one `report` from `box`. Never throws on box input. */
export const recordBoxReport = async (
    database: ControlPlaneStore,
    box: { _id: string; organizationId: string },
    report: ReportMessage,
    now: number,
): Promise<ReportOutcome> => {
    const { windowEnd, windowStart } = report;

    if (windowEnd - windowStart > MAX_REPORT_WINDOW_MS || windowStart < now - MAX_REPORT_AGE_MS || windowEnd > now + MAX_REPORT_SKEW_MS) {
        return { dropped: "out-of-range" };
    }

    const { page: seen } = await database.findMany("platformUsage", { limit: 1, where: { boxId: box._id, windowStart } });

    if (seen.length > 0) {
        return { dropped: "duplicate" };
    }

    const counted = report.perAlias.filter((entry) => entry.requests > 0);

    if (counted.length === 0) {
        return { recorded: 0 };
    }

    // Everything else the box named — another org's alias, a junk one — is
    // dropped here, in memory, for no read at all.
    const live = await liveAliasesOn(database, box);
    let recorded = 0;

    for (const entry of counted) {
        const deploymentId = live.get(entry.alias);

        if (deploymentId === undefined) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one insert per alias the box actually serves
        await database.insert("platformUsage", {
            boxId: box._id,
            createdAt: now,
            deploymentId,
            kind: "requests",
            organizationId: box.organizationId,
            periodStart: periodStartOf(windowStart),
            quantity: entry.requests,
            windowStart,
        });
        recorded += 1;
    }

    return { recorded };
};
