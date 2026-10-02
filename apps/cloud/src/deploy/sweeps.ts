/**
 * Control-plane sweep port-builders (§2.3 / §4). The scheduled Worker runs two
 * data-plane sweeps — tenant teardown and the request-count usage rollback —
 * each expressed as a pure function over injected ports (`runTeardownSweep`,
 * `runUsageRollback`). These builders wire those ports to the control-plane D1,
 * so the row→target mapping, the `teardownAt` marker, the ledger insert, and the
 * per-cell checkpoint are testable against a fake store (server.ts just supplies
 * the real ctx-db and the target drivers).
 *
 * Every row is read with its `target` (absent on rows that predate it, which
 * are `cloudflare-wfp`), so each sweep acts through the right driver.
 */
import type { UsageAttribution, UsageRollbackPorts } from "../metering/rollback";
import type { TargetId } from "../provision-contract";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { UsageRow } from "../targets/driver";
import { storedTarget } from "../targets/registry";
import type { TeardownPorts, TeardownTarget } from "./teardown";

interface TeardownRow {
    _id: string;
    alias?: string;
    kind: string;
    scriptName: string;
    status: string;
    target?: string;
    teardownAt?: number;
}

/**
 * Ports for {@link runTeardownSweep}: destroyed or failed deployments whose
 * stored release has not been reclaimed, each with the target it was deployed
 * to, and the `teardownAt` stamp. `destroy` and `deleteRelease` are supplied by
 * the caller (the target drivers and the `RELEASES` bucket).
 *
 * `destroyWorker` is true only when the alias has no deployment left that is not
 * `destroyed` — so the alias's tenant and D1/R2 are reclaimed on project/org
 * deletion or preview expiry, but never on a routine prune (which would delete
 * the live release's database). Reads the full deployments set once to evaluate
 * that, and elects one pending row per dead alias so the destroy job runs once.
 *
 * `canConverge` says which targets this control plane can tear down right now;
 * a row of any other target stays pending, untouched, until one can — exactly
 * what the whole sweep did before targets, when the provision box was unbound.
 */
export const teardownPorts = (
    database: ControlPlaneDatabase,
    ports: Pick<TeardownPorts, "deleteRelease" | "destroy">,
    now: number,
    canConverge: (target: TargetId) => boolean,
): TeardownPorts => {
    return {
        ...ports,
        listPending: async () => {
            // Drained: teardown has to see every deployment, and a single page left
            // the tail of the fleet permanently un-torn-down — leaking the real
            // dispatch scripts, tenant D1 and R2 that this sweep exists to reclaim.
            const rows = await drainTable<TeardownRow>(database, "deployments");

            // Aliases that still have a deployment that is not destroyed.
            const aliveAliases = new Set<string>();

            // `!= null`, not `!== undefined`: `deployments` is `.global()`, so these rows
            // come from D1, which returns SQL NULL — never `undefined` — for an unset
            // optional column. The checks below all read optional columns, and all
            // invert if they test for `undefined`: the sweep silently selects nothing
            // (leaking every Worker, tenant D1 and R2 bucket forever), and
            // `destroyWorker` flips to `true` for an alias-less row, which is the one
            // case this function exists to prevent.
            for (const row of rows) {
                if (row.status !== "destroyed" && row.alias != null) {
                    aliveAliases.add(row.alias);
                }
            }

            const elected = new Set<string>();

            return (
                rows
                    .filter((row) => (row.status === "destroyed" || row.status === "failed") && row.teardownAt == null)
                    .map((row) => {
                        const alias = row.alias ?? row.scriptName;
                        const destroyWorker = row.status === "destroyed" && row.alias != null && !aliveAliases.has(alias) && !elected.has(alias);

                        if (destroyWorker) {
                            elected.add(alias);
                        }

                        return { alias, destroyWorker, id: row._id, target: storedTarget(row.target) };
                    })
                    // A row whose target is unknown, or cannot converge here, waits.
                    .filter((target): target is TeardownTarget => target.target !== undefined && canConverge(target.target))
            );
        },
        markTornDown: async (id) => {
            await database.patch(id, { teardownAt: now, updatedAt: now }, "deployments");
        },
        releaseAlias: async (alias) => {
            // Drop the ownership ledger row(s) for a fully-torn-down alias so the label
            // is free to re-claim. Idempotent: no row (already released, or a pre-ledger
            // deployment) is a no-op.
            const { page } = await database.findMany("aliasOwnership", { where: { alias } });

            for (const row of page as { _id: string }[]) {
                // eslint-disable-next-line no-await-in-loop -- at most one row per alias (by_alias is unique)
                await database.delete(row._id, "aliasOwnership");
            }
        },
    };
};

interface AttributionRow {
    _id: string;
    organizationId: string;
    resourceRef?: string;
    scriptName: string;
    status: string;
    target?: string;
}

interface CellRow {
    _id: string;
    usageReadAtMs?: number;
}

/**
 * Build the {@link runUsageRollback} ports against the control-plane D1 for one
 * `readback` target. Reads that target's deployment attribution map and this
 * cell's checkpoint up front, then returns ports that resolve a resource →
 * org/deployment, append `requests` rows, and advance the cell's
 * `usageReadAtMs`. No cell row (unregistered cell) → the checkpoint can't
 * persist and the bootstrap window applies each run.
 *
 * The checkpoint is the CELL's, which is `cloudflare-wfp`'s unit of placement
 * and today the only `readback` target. A second readback target needs a
 * checkpoint of its own before it is swept here, or the two would advance one
 * boundary and each skip the other's window.
 */
export const usageRollbackPorts = async (
    database: ControlPlaneDatabase,
    read: (sinceMs: number) => Promise<UsageRow[]>,
    options: { cellName: string; now: number; periodStart: number; target: TargetId },
): Promise<UsageRollbackPorts> => {
    // Drained: this map attributes metered usage to a deployment, so a resource
    // missing from it is usage that lands on nobody's bill.
    const deploymentRows = await drainTable<AttributionRow>(database, "deployments");
    const byResource = new Map<string, UsageAttribution>();

    // Every release of an alias shares its one tenant, so the resource's usage is
    // attributed to the live release when there is one.
    for (const row of deploymentRows) {
        if (storedTarget(row.target) !== options.target) {
            continue;
        }

        // Rows that predate `resourceRef` are addressed by their script name.
        const resourceRef = row.resourceRef ?? row.scriptName;

        if (!byResource.has(resourceRef) || row.status === "live") {
            byResource.set(resourceRef, { deploymentId: row._id, organizationId: row.organizationId });
        }
    }

    const { page: cellPage } = await database.findMany("cells", { where: { name: options.cellName } });
    const cell = (cellPage as CellRow[])[0];

    return {
        getCheckpoint: () => Promise.resolve(cell?.usageReadAtMs),
        now: options.now,
        read,
        record: async ({ attribution, quantity }) => {
            await database.insert("platformUsage", {
                createdAt: options.now,
                deploymentId: attribution.deploymentId,
                kind: "requests",
                organizationId: attribution.organizationId,
                periodStart: options.periodStart,
                quantity,
            });
        },
        resolveResource: (resourceRef) => byResource.get(resourceRef),
        setCheckpoint: async (ms) => {
            if (cell) {
                await database.patch(cell._id, { usageReadAtMs: ms }, "cells");
            }
        },
    };
};
