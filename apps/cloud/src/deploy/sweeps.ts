/**
 * Control-plane sweep port-builders (§2.3 / §4). The scheduled Worker runs two
 * data-plane sweeps — tenant teardown and the request-count usage rollback —
 * each expressed as a pure function over injected ports (`runTeardownSweep`,
 * `runUsageRollback`). These builders wire those ports to the control-plane D1,
 * so the row→target mapping, the `teardownAt` marker, the ledger insert, and the
 * per-scope checkpoint are testable against a fake store (server.ts just supplies
 * the real ctx-db and the target drivers).
 *
 * Every row is read with its `target` (absent on rows that predate it, which
 * are `cloudflare-wfp`), so each sweep acts through the right driver.
 */
import type { UsageAttribution, UsageRollbackPorts } from "../metering/rollback";
import type { TargetId } from "../provision-contract";
import { storedTarget } from "../provision-contract";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { ProgressLine, TargetDriver, UsageRow } from "../targets/driver";
import type { BoxLookups, Placement } from "../targets/placement";
import { placementOfDeployment } from "../targets/placement";
import type { TeardownPorts, TeardownTarget } from "./teardown";

interface TeardownRow {
    _id: string;
    alias?: string;
    boxId?: null | string;
    createdAt?: number;
    kind: string;
    scriptName: string;
    status: string;
    target?: string;
    teardownAt?: number;
}

/**
 * Ports for {@link runTeardownSweep}: destroyed or failed deployments whose
 * stored release has not been reclaimed, each with the target it was deployed
 * to, and the `teardownAt` stamp. `deleteRelease` and `driverFor` are supplied by
 * the caller (the `RELEASES` bucket and the target registry).
 *
 * `destroy` places each alias off its deployment rows (`placementOfDeployment`)
 * and destroys it through that placement's driver. An alias whose box is gone
 * or revoked is beyond reach for good: it is logged and its alias released. One
 * whose box cannot be resolved at all throws, which keeps the row pending and
 * the alias claimed.
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
    ports: Pick<TeardownPorts, "deleteRelease"> & { boxes: BoxLookups; driverFor: (placement: Placement) => TargetDriver; log: ProgressLine },
    now: number,
    canConverge: (target: TargetId) => boolean,
): TeardownPorts => {
    return {
        deleteRelease: ports.deleteRelease,
        destroy: async (target) => {
            const placed = await placementOfDeployment(target, ports.boxes);

            if ("unplaced" in placed) {
                if (!placed.settled) {
                    throw new Error(`alias "${target.alias}" ${placed.unplaced}`);
                }

                ports.log(`alias "${target.alias}": ${placed.unplaced}, releasing the alias`);

                return;
            }

            await ports.driverFor(placed.placement).destroy(target.alias, { onProgress: ports.log });
        },
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

            // The box each alias was last converged on: its newest row that names
            // one. A project that moved boxes leaves older rows naming the old one.
            const boxes = new Map<string, { at: number; boxId: string }>();

            for (const row of rows) {
                const alias = row.alias ?? row.scriptName;
                const at = row.createdAt ?? 0;
                const known = boxes.get(alias);

                if (row.boxId != null && (known === undefined || at >= known.at)) {
                    boxes.set(alias, { at, boxId: row.boxId });
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

                        const boxId = boxes.get(alias)?.boxId;

                        return { alias, ...(boxId === undefined ? {} : { boxId }), destroyWorker, id: row._id, target: storedTarget(row.target) };
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
    usageReadAtMs?: null | number;
}

interface CheckpointRow {
    _id: string;
    readAtMs: number;
}

/**
 * The checkpoint of one (target, scope), and how to advance it. A
 * `cloudflare-wfp` cell swept for the first time since checkpoints moved to
 * `usageCheckpoints` starts from its old `cells.usageReadAtMs`, so the move
 * neither re-reads nor skips a window.
 */
const checkpointPorts = async (
    database: ControlPlaneDatabase,
    options: { now: number; scope: string; target: TargetId },
): Promise<Pick<UsageRollbackPorts, "getCheckpoint" | "setCheckpoint">> => {
    const { page } = await database.findMany("usageCheckpoints", { where: { scopeKey: options.scope, target: options.target } });
    const row = (page as CheckpointRow[]).at(0);
    let seed: number | undefined;

    if (row === undefined && options.target === "cloudflare-wfp") {
        const { page: cells } = await database.findMany("cells", { where: { name: options.scope } });

        seed = (cells as CellRow[])[0]?.usageReadAtMs ?? undefined;
    }

    return {
        getCheckpoint: () => Promise.resolve(row?.readAtMs ?? seed),
        setCheckpoint: async (ms) => {
            await (row === undefined
                ? database.insert("usageCheckpoints", { readAtMs: ms, scopeKey: options.scope, target: options.target, updatedAt: options.now })
                : database.patch(row._id, { readAtMs: ms, updatedAt: options.now }, "usageCheckpoints"));
        },
    };
};

/**
 * Build the {@link runUsageRollback} ports against the control-plane D1 for
 * one scope of one `readback` target. Reads that target's deployment
 * attribution map and the scope's checkpoint (`usageCheckpoints`) up front,
 * then returns ports that resolve a resource → org/deployment, append
 * `requests` rows, and advance the scope's checkpoint — never another
 * scope's, so two sources of one target never skip each other's windows.
 */
export const usageRollbackPorts = async (
    database: ControlPlaneDatabase,
    read: (sinceMs: number) => Promise<UsageRow[]>,
    options: { now: number; periodStart: number; scope: string; target: TargetId },
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

    return {
        ...(await checkpointPorts(database, options)),
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
    };
};
