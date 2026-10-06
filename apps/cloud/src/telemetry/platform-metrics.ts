/**
 * Platform self-metrics (GAPS.md E1): what the control plane and the dispatcher
 * say about THEMSELVES — dispatcher latency and outcome, build/deploy queue
 * depth, provisioning failures. The studio observes tenants; this observes us.
 *
 * One Analytics Engine dataset of its own, bound as `PLATFORM_METRICS` on both
 * Workers, so nothing here can touch the billing meter's blob/double positions
 * (`recordRequestUsage`) or the tenant metrics stream (`TELEMETRY`). Rows are
 * told apart by `blob1`, and `index1` is the same metric kind: AE samples per
 * index, so a million dispatches an hour can never sample the one queue row a
 * minute down to nothing.
 *
 * Layouts (positions are append-only, as with the meter):
 *
 * - `dispatch`: blob2 cell, blob3 outcome (`2xx`…`5xx`, `exception`); double1 duration ms
 * - `queue`: blob2 cell; double1 pending builds, double2 running builds, double3 in-flight deploys
 * - `provision_failure`: blob2 cell, blob3 step, blob4 reason; double1 = 1
 *
 * Every dimension is a closed set or a cell name. No tenant hostname, script
 * name, error message or secret reaches this dataset.
 *
 * Every writer is a no-op without the binding and never throws: `writeDataPoint`
 * is already fire-and-forget, and an instrumentation fault must not fail the
 * request or the deploy it measures.
 */
import type { AnalyticsEngineDatasetLike } from "@lunora/bindings/analytics";
import { getCatalogEntry, isLunoraError } from "@lunora/errors";

import type { ControlPlaneDatabase } from "../store";

/** The `blob1`/`index1` discriminator of each row kind. */
export const PLATFORM_METRIC_KINDS = { dispatch: "dispatch", provisionFailure: "provision_failure", queue: "queue" } as const;

/** Where in a release a provisioning failure happened — a closed set, so it is free to group on. */
export type ProvisionStep = "activate" | "converge" | "secrets" | "status" | "store" | "verify";

const write = (dataset: AnalyticsEngineDatasetLike | undefined, kind: string, blobs: string[], doubles: number[]): void => {
    if (!dataset) {
        return;
    }

    try {
        dataset.writeDataPoint({ blobs: [kind, ...blobs], doubles, indexes: [kind] });
    } catch {
        // Best-effort by design — see the module note.
    }
};

/** One dispatched request: how long the dispatcher held it and how it ended. */
export const recordDispatch = (dataset: AnalyticsEngineDatasetLike | undefined, input: { cell: string; durationMs: number; outcome: string }): void => {
    write(dataset, PLATFORM_METRIC_KINDS.dispatch, [input.cell, input.outcome], [input.durationMs]);
};

/** One queue-depth sample, taken on the every-minute cron tick. */
export const recordQueueDepth = (
    dataset: AnalyticsEngineDatasetLike | undefined,
    input: { buildsPending: number; buildsRunning: number; cell: string; deploysInFlight: number },
): void => {
    write(dataset, PLATFORM_METRIC_KINDS.queue, [input.cell], [input.buildsPending, input.buildsRunning, input.deploysInFlight]);
};

/** A deployment between "accepted" and a terminal state — what the deploy queue holds. */
const IN_FLIGHT_DEPLOY_STATUSES = ["queued", "provisioning", "building", "verifying"] as const;

// ponytail: one page per status, so a depth past 1000 reads as 1000 — a queue
// that deep is already the alert; drain with `drainTable` if exact counts matter.
const QUEUE_SAMPLE_LIMIT = 1000;

/** Count pending and running git builds, and deployments still in flight. */
export const readQueueDepth = async (
    database: Pick<ControlPlaneDatabase, "findMany">,
): Promise<{ buildsPending: number; buildsRunning: number; deploysInFlight: number }> => {
    const count = async (table: string, status: string): Promise<number> => {
        const { page } = await database.findMany(table, { limit: QUEUE_SAMPLE_LIMIT, where: { status } });

        return page.length;
    };
    const [buildsPending, buildsRunning, ...deploys] = await Promise.all([
        count("builds", "pending"),
        count("builds", "building"),
        ...IN_FLIGHT_DEPLOY_STATUSES.map(async (status) => count("deployments", status)),
    ]);

    return { buildsPending, buildsRunning, deploysInFlight: deploys.reduce((sum, value) => sum + value, 0) };
};

/** One failed release, by the step it failed at and a bounded reason ({@link failureReason}). */
export const recordProvisionFailure = (dataset: AnalyticsEngineDatasetLike | undefined, input: { cell: string; reason: string; step: ProvisionStep }): void => {
    write(dataset, PLATFORM_METRIC_KINDS.provisionFailure, [input.cell, input.step, input.reason], [1]);
};

/** An error class name that is safe to keep as a dimension: a bare identifier, short. */
const ERROR_NAME = /^[A-Z][A-Za-z]{0,39}$/u;

/**
 * A low-cardinality reason for a failure: its catalogued `LunoraError` code, else
 * its error class name (`TypeError`, `TimeoutError`), else `unknown`.
 *
 * Never the message. Messages carry hostnames, script names and provider
 * response text — unbounded, and not ours to retain.
 */
export const failureReason = (error: unknown): string => {
    if (isLunoraError(error) && getCatalogEntry(error.code) !== undefined) {
        return error.code;
    }

    return error instanceof Error && error.name !== "Error" && ERROR_NAME.test(error.name) ? error.name : "unknown";
};
