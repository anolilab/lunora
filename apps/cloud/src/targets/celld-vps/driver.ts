/**
 * `celld-vps` — a project runs as a celld fleet on a machine its organization
 * enrolled (plan 458): one fleet per alias on the box, behind the box's Caddy,
 * at `{alias}.{boxSlug}.{LUNORA_BOX_DOMAIN}`.
 *
 * The control plane never holds a credential for the box (§3 rule 5). Every
 * converge is a JOB handed to the box's `lunora-hostd` over its session
 * (`BoxSessionDO`, plan 458 G11): `deploy` names the stored release, which the
 * box downloads with a signed request (G14); `destroy` stops the fleet and
 * deletes its data. A box that is not connected fails the converge at once
 * (D14) — a deploy is never queued for a box that may come back hours later.
 *
 * A driver is built for ONE box — the project's placement, or, for a teardown,
 * the box its deployment row names (`placementOfDeployment`). A revoked or
 * deleted box never reaches a driver: placement refuses it first.
 *
 * {@link createCelldVpsDriver} is pure over {@link CelldVpsPorts}, so the
 * conformance suite drives it with a fake box. {@link celldVpsDriverFromEnv} is
 * the one place those ports are read off the Worker env.
 */
import type { DeployJob, HostdJob } from "@lunora/hostd/protocol";

import { tenantSender } from "../../backup/tenant-transport";
import type { BoxSession, BoxSessionNamespace } from "../../boxes/session-client";
import { boxSession } from "../../boxes/session-client";
import { boxDomainOf, boxReleaseUrlOf } from "../../boxes/urls";
import type { ConvergeOptions, TargetDriver, TargetFleet } from "../driver";
import type { BoxHost } from "../placement";
import type { BoxDnsEnvironment } from "./dns";

/** How long a box may take to fetch, deploy and health-check a release. */
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a box may take to stop a fleet and delete its data. */
const DESTROY_TIMEOUT_MS = 5 * 60 * 1000;

export interface CelldVpsPorts {
    /** The box this driver converges on — the project's placement. */
    box: BoxHost;
    /** The apex box hostnames live under (`LUNORA_BOX_DOMAIN`). */
    boxDomain: string;
    /** This control plane's public origin (`LUNORA_ORIGIN_URL`): where a box fetches a release from. */
    controlPlaneOrigin: string;
    /** The box's session. */
    session: (boxId: string) => BoxSession;
}

/** Map a failed or refused box job onto the error the deploy stream shows. */
const jobFailure = (slug: string, action: string, error: { code: string; message: string } | undefined): Error =>
    error?.code === "BOX_OFFLINE"
        ? new Error(`box "${slug}" is offline (BOX_OFFLINE): start lunora-hostd on it and ${action} again`)
        : new Error(`box "${slug}" could not ${action}: ${error?.code ?? "FAILED"}: ${error?.message ?? "no reason given"}`);

export const createCelldVpsDriver = (ports: CelldVpsPorts): TargetDriver => {
    const { box } = ports;
    const session = (): BoxSession => ports.session(box.id);

    /** Run one job on the box, and turn anything but `ok` into a thrown error. */
    const run = async (action: string, job: HostdJob, timeoutMs: number, options: ConvergeOptions): Promise<void> => {
        const outcome = await session().dispatch(job, { ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }), timeoutMs });

        if (!outcome.ok) {
            throw jobFailure(box.slug, action, outcome.error);
        }

        // The box serves the hostname only once its routing table names it; a
        // failed push is retried on the box's next connect, so it does not fail the job.
        await session()
            .pushRoutes()
            .catch(() => false);
    };

    return {
        deploy: async (spec, options = {}) => {
            const job: DeployJob = {
                alias: spec.alias,
                ...(spec.manifest.compatibilityDate === undefined ? {} : { compatibilityDate: spec.manifest.compatibilityDate }),
                crons: spec.crons ?? [],
                deploymentId: spec.deploymentId,
                kind: "deploy",
                releaseUrl: boxReleaseUrlOf(ports.controlPlaneOrigin, spec.deploymentId),
                // celld has no secret store, so secrets ride as vars (plan 458 D10) and
                // persist in the customer's own bucket. Secrets win a name clash, as on
                // every target: `LUNORA_ADMIN_TOKEN` is platform-owned.
                vars: { ...spec.vars, ...spec.secrets },
            };

            await run("deploy", job, DEPLOY_TIMEOUT_MS, options);

            return { url: `https://${spec.alias}.${box.slug}.${ports.boxDomain}` };
        },
        // Reached only once the alias has no deployment left — an expired preview
        // or a deleted project (the teardown sweep) — so the data goes too, exactly
        // as a cloudflare-wfp teardown deletes its D1 and R2. A box that is offline
        // throws, which leaves the row pending for the next tick.
        destroy: async (alias, options = {}) => {
            await run("destroy", { alias, deleteData: true, kind: "destroy" }, DESTROY_TIMEOUT_MS, options);
        },
        domains: {
            // Rebuilt from the remaining domain rows, so the removed one drops out.
            afterRemoved: async (): Promise<void> => {
                await session().pushRoutes();
            },
            // A box serves a custom domain once its routing table names it (plan 458 W5).
            onVerified: async (): Promise<undefined> => {
                await session()
                    .pushRoutes()
                    .catch(() => false);
            },
            // A custom domain CNAMEs to the box itself; its Caddy terminates TLS (plan 458 W5).
            platformTargets: () => [`${box.slug}.${ports.boxDomain}`],
        },
        id: "celld-vps",
    };
};

/** `celld-vps` across every box: tenants answer on their public hostname, where backups and the admin proxy reach them. */
export const celldVpsFleet: TargetFleet = { id: "celld-vps", reach: (tenant) => tenantSender(tenant) };

/** The env slice the `celld-vps` driver reads. A `type` so the control plane's env types stay assignable to it. */
export type CelldVpsEnvironment = {
    /** The per-box session namespace (`BoxSessionDO`); absent → this control plane cannot reach boxes. */
    BOX_SESSION?: BoxSessionNamespace;
    DB?: unknown;
    LUNORA_BOX_DOMAIN?: string;
    /** This control plane's public origin — the base of every `releaseUrl` a box is handed. */
    LUNORA_ORIGIN_URL?: string;
} & BoxDnsEnvironment;

/** Whether this control-plane deployment can converge and tear down `celld-vps` tenants. */
export const celldVpsCanConverge = (environment: CelldVpsEnvironment): boolean =>
    environment.BOX_SESSION != null && environment.DB != null && environment.LUNORA_ORIGIN_URL != null;

/** Build the driver for one box off the Worker env. Lazy: nothing is touched until a member is called. */
export const celldVpsDriverFromEnv = (box: BoxHost, environment: CelldVpsEnvironment): TargetDriver =>
    createCelldVpsDriver({
        box,
        boxDomain: boxDomainOf(environment),
        controlPlaneOrigin: environment.LUNORA_ORIGIN_URL ?? "",
        session: (boxId) => {
            if (!environment.BOX_SESSION) {
                throw new Error("this control plane has no box sessions bound (BOX_SESSION)");
            }

            return boxSession(environment.BOX_SESSION, boxId);
        },
    });
