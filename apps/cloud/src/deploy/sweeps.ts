/**
 * Control-plane sweep port-builders (§2.3 / §4). The scheduled Worker runs two
 * data-plane sweeps — Cloudflare resource teardown and the Analytics-Engine
 * usage rollback — each expressed as a pure function over injected ports
 * (`runTeardownSweep`, `runUsageRollback`). These builders wire those ports to
 * the control-plane D1, so the row→target mapping, the `teardownAt` marker, the
 * ledger insert, and the per-cell checkpoint are testable against a fake store
 * (server.ts just supplies the real ctx-db + Cloudflare clients).
 */
import type { AnalyticsUsageReader } from "../metering/analytics";
import type { UsageAttribution, UsageRollbackPorts } from "../metering/rollback";
import type { TeardownPorts } from "./teardown";

/** The minimal control-plane store surface the sweeps use (structurally the D1 ctx-db). */
export interface ControlPlaneDb {
    findMany: (
        table: string,
        // `limit`/`orderBy` are pass-throughs the underlying ctx-db already honors
        // (the alert sweep bounds its recent-observation read with them); the
        // teardown/usage sweeps pass only `where`.
        args?: { limit?: number; orderBy?: Record<string, "asc" | "desc">[]; where?: Record<string, unknown> },
    ) => Promise<{ page: unknown[] }>;
    insert: (table: string, document: Record<string, unknown>) => Promise<unknown>;
    patch: (id: string, patch: Record<string, unknown>, table?: string) => Promise<unknown>;
}

interface TeardownRow {
    _id: string;
    kind: string;
    scriptName: string;
    teardownAt?: number;
}

/**
 * Ports for {@link runTeardownSweep}: destroyed deployments whose script has not
 * been torn down (dispatch namespace derived as `lunora-{kind}`, mirroring the
 * deploy router), and the `teardownAt` stamp. `destroy` is supplied by the
 * caller (the composite Cloudflare teardown).
 */
export const teardownPorts = (database: ControlPlaneDb, destroy: TeardownPorts["destroy"], now: number): TeardownPorts => ({
    destroy,
    listPending: async () => {
        const { page } = await database.findMany("deployments", { where: { status: "destroyed" } });

        return (page as TeardownRow[])
            .filter((row) => row.teardownAt === undefined)
            .map((row) => ({ dispatchNamespace: `lunora-${row.kind}`, id: row._id, scriptName: row.scriptName }));
    },
    markTornDown: async (id) => {
        await database.patch(id, { teardownAt: now, updatedAt: now }, "deployments");
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
