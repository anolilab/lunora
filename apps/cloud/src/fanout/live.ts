/**
 * The live deployments the cron fan-out and the platform queue consumer act on,
 * read off the control-plane D1 (admin tokens stay sealed here; each caller
 * unseals the one it uses, in-process).
 */
import type { D1DatabaseLike } from "@lunora/d1";

import type { AdmissionRow } from "../billing/spend";
import { organizationServing } from "../billing/spend";
import type { ControlPlaneStore } from "../d1-store";
import { controlPlaneDatabase } from "../d1-store";
import { drainTable } from "../store";

export interface LiveDeploymentRow {
    adminToken?: string;
    adminTokenCiphertext?: string;
    adminTokenIv?: string;
    alias?: string;
    cronSpecs?: string[];
    liveAt?: number;
    organizationId?: string;
    projectId?: string;
    resourceRef?: string;
    scriptName: string;
    target?: string;
}

/**
 * Read every live deployment; none without the control-plane D1. Drained, not
 * one page: a fan-out that read only the first page would silently skip every
 * tenant past it.
 */
export const readLiveDeployments = async (environment: { DB?: unknown }): Promise<LiveDeploymentRow[]> =>
    environment.DB ? drainTable<LiveDeploymentRow>(controlPlaneDatabase(environment.DB as D1DatabaseLike), "deployments", { where: { status: "live" } }) : [];

/**
 * The live deployments whose organization may run right now
 * (`organizationServing`, read from each organization's row at call time).
 * Suspension otherwise stops only traffic through the dispatcher: the cron
 * fan-out and the platform queue consumer dispatch to the tenant directly, so
 * without this a suspended — or over-cap — tenant kept running both. A row with
 * no organization, or one whose organization cannot be read, fails closed.
 */
export const servingDeployments = async (store: ControlPlaneStore, rows: ReadonlyArray<LiveDeploymentRow>, now: number): Promise<LiveDeploymentRow[]> => {
    const organizationIds = [...new Set(rows.flatMap((row) => (row.organizationId === undefined ? [] : [row.organizationId])))];
    const organizations = await Promise.all(
        organizationIds.map(async (id) => [id, (await store.get(id, "organizations").catch(() => null)) as AdmissionRow | null] as const),
    );
    const serving = new Set(organizations.filter(([, row]) => organizationServing(row, now)).map(([id]) => id));

    return rows.filter((row) => row.organizationId !== undefined && serving.has(row.organizationId));
};

/** The key an emergency stop holds a release by: its alias AND its project, so a row another project left on the alias holds nothing. */
export const haltKey = (row: Pick<LiveDeploymentRow, "alias" | "projectId" | "scriptName">): string => `${row.projectId ?? ""}/${row.alias ?? row.scriptName}`;

/**
 * What an emergency stop holds (`halts`, `src/deploy/halt.ts`), whatever the
 * row's progress, keyed by {@link haltKey}: their crons are not ticked and
 * their queue batches are not delivered — the stub on their Worker would only
 * answer 503 — until the row is gone. None without the control-plane D1.
 */
export const readHalted = async (environment: { DB?: unknown }): Promise<Set<string>> => {
    if (!environment.DB) {
        return new Set();
    }

    const rows = await drainTable<{ alias: string; projectId: string }>(controlPlaneDatabase(environment.DB as D1DatabaseLike), "halts");

    return new Set(rows.map((row) => haltKey({ alias: row.alias, projectId: row.projectId, scriptName: row.alias })));
};

/** The live deployments no emergency stop holds — the ones the cron fan-out ticks. */
export const withoutHalted = <Row extends Pick<LiveDeploymentRow, "alias" | "projectId" | "scriptName">>(
    live: ReadonlyArray<Row>,
    halted: ReadonlySet<string>,
): Row[] => live.filter((row) => !halted.has(haltKey(row)));

/** The handle a target addresses a deployment by: `resourceRef`, or the script name on rows that predate it. */
export const resourceRefOf = (row: { resourceRef?: null | string; scriptName: string }): string => row.resourceRef ?? row.scriptName;
