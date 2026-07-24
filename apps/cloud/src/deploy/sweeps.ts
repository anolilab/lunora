/**
 * Control-plane sweep port-builders (§2.3 / §4). The scheduled Worker runs two
 * data-plane sweeps — Cloudflare resource teardown and the Analytics-Engine
 * usage rollback — each expressed as a pure function over injected ports
 * (`runTeardownSweep`, `runUsageRollback`). These builders wire those ports to
 * the control-plane D1, so the row→target mapping, the `teardownAt` marker, the
 * ledger insert, and the per-cell checkpoint are testable against a fake store
 * (server.ts just supplies the real ctx-db + Cloudflare clients).
 */
import type { ControlPlaneDb } from "../store";
import type { AnalyticsUsageReader } from "../metering/analytics";
import type { UsageAttribution, UsageRollbackPorts } from "../metering/rollback";
import type { TeardownPorts } from "./teardown";

interface TeardownRow {
    _id: string;
    alias?: string;
    kind: string;
    scriptName: string;
    status: string;
    teardownAt?: number;
}

/**
 * Ports for {@link runTeardownSweep}: destroyed deployments whose script has not
 * been torn down (dispatch namespace derived as `lunora-{kind}`, mirroring the
 * deploy router), and the `teardownAt` stamp. `destroy` is supplied by the
 * caller (the composite Cloudflare teardown).
 *
 * `deleteResources` is true only when the alias has no remaining non-destroyed
 * deployment — so the per-project D1/R2 are reclaimed on project/org deletion
 * but never on a routine version prune (which would delete the live version's
 * database). Reads the full deployments set once to evaluate that.
 */
export const teardownPorts = (database: ControlPlaneDb, destroy: TeardownPorts["destroy"], now: number): TeardownPorts => ({
    destroy,
    listPending: async () => {
        const { page } = await database.findMany("deployments", {});
        const rows = page as TeardownRow[];

        // Aliases that still have a live/superseded/etc (non-destroyed) deployment.
        const aliveAliases = new Set<string>();

        for (const row of rows) {
            if (row.status !== "destroyed" && row.alias !== undefined) {
                aliveAliases.add(row.alias);
            }
        }

        return rows
            .filter((row) => row.status === "destroyed" && row.teardownAt === undefined)
            .map((row) => {
                const alias = row.alias ?? row.scriptName;

                return {
                    alias,
                    deleteResources: row.alias === undefined ? false : !aliveAliases.has(alias),
                    dispatchNamespace: `lunora-${row.kind}`,
                    id: row._id,
                    scriptName: row.scriptName,
                };
            });
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
});

interface AttributionRow {
    _id: string;
    organizationId: string;
    scriptName: string;
}

interface CellRow {
    _id: string;
    usageReadAtMs?: number;
}

/**
 * Build the {@link runUsageRollback} ports against the control-plane D1. Reads
 * the deployment attribution map and this cell's checkpoint up front, then
 * returns ports that resolve a script → org/deployment, append `requests` rows,
 * and advance the cell's `usageReadAtMs`. No cell row (unregistered cell) → the
 * checkpoint can't persist and the bootstrap window applies each run.
 */
export const usageRollbackPorts = async (
    database: ControlPlaneDb,
    reader: AnalyticsUsageReader,
    options: { cellName: string; now: number; periodStart: number },
): Promise<UsageRollbackPorts> => {
    const { page: deploymentPage } = await database.findMany("deployments", {});
    const byScript = new Map<string, UsageAttribution>();

    for (const row of deploymentPage as AttributionRow[]) {
        byScript.set(row.scriptName, { deploymentId: row._id, organizationId: row.organizationId });
    }

    const { page: cellPage } = await database.findMany("cells", { where: { name: options.cellName } });
    const cell = (cellPage as CellRow[])[0];

    return {
        getCheckpoint: () => Promise.resolve(cell?.usageReadAtMs),
        now: options.now,
        read: (sinceMs) => reader.readRequestUsage(sinceMs),
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
        resolveScript: (scriptName) => byScript.get(scriptName),
        setCheckpoint: async (ms) => {
            if (cell) {
                await database.patch(cell._id, { usageReadAtMs: ms }, "cells");
            }
        },
    };
};
