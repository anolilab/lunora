/**
 * The tenant cron fan-out for `fanout: "dispatcher"` targets: a Workers for
 * Platforms tenant carries no cron triggers of its own, so the control plane
 * ticks each live release's `/_lunora/scheduled` over its fleet's in-network
 * `dispatch`, gated by the release's admin token.
 */
import type { ControlPlaneStore } from "../d1-store";
import { resolveAdminToken } from "../deploy/admin-token";
import type { TargetId } from "../provision-contract";
import { storedTarget } from "../provision-contract";
import type { TargetFleet } from "../targets/driver";
import type { CronTarget, CronTick } from "./cron";
import { fanOutCron } from "./cron";
import type { LiveDeploymentRow } from "./live";
import { resourceRefOf, servingDeployments } from "./live";

type TenantDispatch = NonNullable<TargetFleet["dispatch"]>;

/** What {@link runTenantCrons} needs: each fleet's in-network path, the live deployments, and the store their organizations are read from. */
export interface TenantCronPorts {
    fleets: ReadonlyArray<{ dispatch: TenantDispatch; target: TargetId }>;
    live: ReadonlyArray<LiveDeploymentRow>;
    now: Date;
    secretEncryptionKey?: string;
    store: ControlPlaneStore;
}

/**
 * Live deployments that declare cron expressions, shaped for the cron fan-out.
 * The stored admin token is sealed at rest (§7), so it is decrypted in-process
 * here with the master key before it becomes the tenant Bearer.
 */
const cronTargets = async (live: ReadonlyArray<LiveDeploymentRow>, secretEncryptionKey: string | undefined): Promise<CronTarget[]> => {
    const resolved = await Promise.all(
        live.map(async (row) => {
            return { adminToken: await resolveAdminToken(row, secretEncryptionKey), cronSpecs: row.cronSpecs, scriptName: resourceRefOf(row) };
        }),
    );

    return resolved.flatMap((row) =>
        row.adminToken && Array.isArray(row.cronSpecs) && row.cronSpecs.length > 0
            ? [{ adminToken: row.adminToken, cronSpecs: row.cronSpecs, scriptName: row.scriptName }]
            : [],
    );
};

/** Tick one tenant's cron over its driver's in-network path, gated by its admin token. */
const dispatchCronTick = async (dispatch: TenantDispatch, tick: CronTick): Promise<boolean> => {
    const send = dispatch({ adminToken: tick.adminToken, resourceRef: tick.scriptName });
    const response = await send("/_lunora/scheduled", JSON.stringify({ cron: tick.cron }), "application/json");

    return response.ok;
};

/**
 * Tick every due cron of every serving tenant. A suspended or over-cap
 * organization's crons do not tick: this path reaches the tenant directly,
 * past the dispatcher's admission check, so suspension is enforced here too.
 */
export const runTenantCrons = async (ports: TenantCronPorts): Promise<void> => {
    const serving = await servingDeployments(ports.store, ports.live, ports.now.getTime());

    await Promise.all(
        ports.fleets.map(async ({ dispatch, target }) => {
            const targets = await cronTargets(
                serving.filter((row) => storedTarget(row.target) === target),
                ports.secretEncryptionKey,
            );

            await fanOutCron({ dispatch: (tick) => dispatchCronTick(dispatch, tick), now: ports.now, targets });
        }),
    );
};
