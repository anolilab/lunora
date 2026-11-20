/**
 * The deployment status state table, and the one check every writer of a deployment's
 * `status` runs before it writes. `updateStatus` used to be the only writer that checked the
 * table; `activate`, `rollback`, the halt resume, the superseded prune, the preview cleanup
 * and the project and organization deletes wrote `status` directly. They now all call
 * {@link assertStatusMove}, so the table is the single rule.
 */
import { LunoraError } from "@lunora/errors";

import type { DEPLOYMENT_STATUSES } from "../../lunora/tables/shared";

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * The status moves the system performs, keyed by the status a deployment is in.
 * Every writer that sets `status` is refused a move not listed here. Every entry is a write some
 * writer really makes:
 *
 * - `queued → provisioning → verifying → live`, the orchestrator's progress
 *   events forwarded by `src/deploy/release-core.ts`. A release without a health
 *   check goes `provisioning → live`.
 * - `→ failed` from any in-flight state. `live → failed` is an activation that
 *   fails after the live write (`fail("activate")` in `release-core.ts`).
 * - `live → superseded` and `superseded → live`: `activate`, `rollback`, and a
 *   halt's resume (`halt-converge.ts`).
 * - `→ destroyed`: an expired preview, a deleted project or organization, and
 *   the superseded prune (`pruneSuperseded`). A row stuck in `building`, which
 *   nothing creates now but an older build may have left behind, is torn down
 *   the same way.
 * - Same-status writes: the orchestrator re-drives `updateStatus`, and a retry
 *   can write a status the row already holds.
 *
 * `building` is the one status with a single exit, to `destroyed`. It stays in
 * the status union for the client's phase view.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<DeploymentStatus, ReadonlyArray<DeploymentStatus>>> = {
    building: ["destroyed"],
    destroyed: [],
    failed: ["failed", "destroyed"],
    live: ["live", "superseded", "failed", "destroyed"],
    provisioning: ["provisioning", "verifying", "live", "failed", "destroyed"],
    queued: ["provisioning", "failed", "destroyed"],
    superseded: ["live", "destroyed"],
    verifying: ["verifying", "live", "failed", "destroyed"],
};

/** Whether `value` is a status the table knows. A stored row's status is a string until checked. */
export const isDeploymentStatus = (value: string): value is DeploymentStatus => Object.hasOwn(ALLOWED_TRANSITIONS, value);

/**
 * Refuse a status move the table does not list, with a CONFLICT naming both statuses. Call it
 * before the write, and for every row a writer will touch before the first of them is written,
 * so a refused move never leaves the batch half-applied.
 * @throws {LunoraError} `CONFLICT` for a move the table does not list, or a `from` it does not know.
 */
export const assertStatusMove = (from: string, to: DeploymentStatus): void => {
    if (!isDeploymentStatus(from) || !ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new LunoraError("CONFLICT", `cannot move a ${from} deployment to ${to}`);
    }
};
