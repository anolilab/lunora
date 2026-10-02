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

interface ProjectRow {
    _id: string;
    boxId?: null | string;
    organizationId: string;
}

/** The live deployment `alias` serves from, when the alias's project is placed on `box`. */
const liveDeploymentOn = async (database: ControlPlaneStore, box: { _id: string; organizationId: string }, alias: string): Promise<null | string> => {
    const { page: owners } = await database.findMany("aliasOwnership", { where: { alias } });
    const owner = owners[0] as undefined | { projectId: string };
    const project = owner ? ((await database.get(owner.projectId, "projects")) as null | ProjectRow) : null;

    if (project?.boxId !== box._id || project.organizationId !== box.organizationId) {
        return null;
    }

    const { _id: projectId } = project;
    const { page } = await database.findMany("deployments", { where: { alias, projectId, status: "live" } });
    const deployment = page[0] as undefined | { _id: string };

    return deployment?._id ?? null;
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

    let recorded = 0;

    for (const entry of report.perAlias) {
        if (entry.requests <= 0) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- a box serves one org's handful of aliases
        const deploymentId = await liveDeploymentOn(database, box, entry.alias);

        if (deploymentId === null) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- see above
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
