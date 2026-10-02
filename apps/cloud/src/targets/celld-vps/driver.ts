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
 * {@link createCelldVpsDriver} is pure over {@link CelldVpsPorts}, so the
 * conformance suite drives it with a fake box. {@link celldVpsDriverFromEnv} is
 * the one place those ports are read off the Worker env.
 */
import type { D1DatabaseLike } from "@lunora/d1";
import type { DeployJob } from "@lunora/hostd/protocol";

import { tenantSender } from "../../backup/tenant-transport";
import type { BoxSession, BoxSessionNamespace } from "../../boxes/session-client";
import { boxSession, BoxSessionError } from "../../boxes/session-client";
import { boxDomainOf, boxReleaseUrlOf } from "../../boxes/urls";
import type { ControlPlaneStore } from "../../d1-store";
import { controlPlaneDatabase } from "../../d1-store";
import { sha256HexBytes } from "../../deploy/keys";
import stripTrailingSlashes from "../../lib/strip-trailing-slashes";
import { BINDING_SUPPORT, UNSUPPORTED_REASONS } from "../../provision-contract";
import type { TargetDriver, UsageRow } from "../driver";
import type { BoxPlacement } from "../placement";
import type { BoxDnsEnvironment } from "./dns";

/** How long a box may take to fetch, deploy and health-check a release. */
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a box may take to stop a fleet and delete its data. */
const DESTROY_TIMEOUT_MS = 5 * 60 * 1000;

/** A box as the driver addresses it. */
export interface BoxReference extends BoxPlacement {
    revoked: boolean;
}

export interface CelldVpsPorts {
    /**
     * The box this driver converges on — the project's placement, on the deploy
     * path. Absent for the fleet-wide driver the sweeps build, which resolves a
     * box per alias instead and cannot name a tenant URL.
     */
    box?: BoxPlacement;
    /** The box row `id`, or `null` when there is none (deleted with its organization). */
    boxById: (id: string) => Promise<BoxReference | null>;
    /** The apex box hostnames live under (`LUNORA_BOX_DOMAIN`). */
    boxDomain: string;
    /** The box a deployed alias lives on, for a teardown that knows only the alias. `null` when it is on none. */
    boxForAlias: (alias: string) => Promise<BoxReference | null>;
    /** The box with DNS label `slug`, for routing a hostname. */
    boxForSlug: (slug: string) => Promise<BoxReference | null>;
    /** This control plane's public origin (`LUNORA_ORIGIN_URL`): where a box fetches a release from. */
    controlPlaneOrigin: string;
    /** Receives the driver's own log lines (Workers Logs): what a teardown deliberately left behind. */
    onLog?: (line: string) => void;
    /** Receives each progress line the box streams while it converges. */
    onProgress?: (line: string) => void;
    /** A box's session. */
    session: (boxId: string) => BoxSession;
    /** Requests per alias reported by boxes after `sinceMs` (`platformUsage` box rows). Display only (D12). */
    usage?: (sinceMs: number) => Promise<UsageRow[]>;
}

/** Map a failed or refused box job onto the error the deploy stream shows. */
const jobFailure = (slug: string, action: string, error: unknown): Error => {
    if (error instanceof BoxSessionError && error.code === "BOX_OFFLINE") {
        return new Error(`box "${slug}" is offline (BOX_OFFLINE): start lunora-hostd on it and ${action} again`);
    }

    return new Error(`box "${slug}" could not ${action}: ${error instanceof Error ? error.message : String(error)}`);
};

export const createCelldVpsDriver = (ports: CelldVpsPorts): TargetDriver => {
    const hostFor = (alias: string, slug: string): string => `${alias}.${slug}.${ports.boxDomain}`;
    const tenantUrl = (alias: string): string => {
        if (ports.box === undefined) {
            throw new Error("a celld-vps tenant URL is the project's box's; this driver was built without one");
        }

        return `https://${hostFor(alias, ports.box.slug)}`;
    };
    const { usage } = ports;

    /** Run one job on a box, and turn anything but `ok` into a thrown error. */
    const run = async (box: BoxPlacement, action: string, job: Parameters<BoxSession["dispatch"]>[0], timeoutMs: number): Promise<void> => {
        const outcome = await ports
            .session(box.id)
            .dispatch(job, { ...(ports.onProgress === undefined ? {} : { onProgress: ports.onProgress }), timeoutMs })
            .catch((error: unknown) => {
                throw jobFailure(box.slug, action, error);
            });

        if (!outcome.ok) {
            throw new Error(`box "${box.slug}" could not ${action}: ${outcome.error?.code ?? "FAILED"}: ${outcome.error?.message ?? "no reason given"}`);
        }

        // The box serves the hostname only once its routing table names it; a
        // failed push is retried on the box's next connect, so it does not fail the job.
        await ports
            .session(box.id)
            .pushRoutes()
            .catch(() => false);
    };

    return {
        bindingSupport: BINDING_SUPPORT["celld-vps"],
        capabilities: { fanout: "native", metering: "pushed" },
        deploy: async (spec) => {
            const box = ports.box ?? (await ports.boxForAlias(spec.alias));

            if (!box) {
                throw new Error(`alias "${spec.alias}" has no box to deploy to`);
            }

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

            const [bundleHash] = await Promise.all([sha256HexBytes(spec.bundle), run(box, "deploy", job, DEPLOY_TIMEOUT_MS)]);

            return { bundleHash, url: `https://${hostFor(spec.alias, box.slug)}` };
        },
        destroy: async (reference) => {
            const box = ports.box ?? (reference.boxId === undefined ? await ports.boxForAlias(reference.alias) : await ports.boxById(reference.boxId));

            if (box === null) {
                // The deployment row names a box that no longer exists: it was deleted
                // with its organization, and nothing can reach the machine any more.
                if (reference.boxId !== undefined) {
                    ports.onLog?.(`alias "${reference.alias}": box ${reference.boxId} no longer exists; nothing to stop, releasing the alias`);

                    return;
                }

                // A row that predates `deployments.boxId`, whose project is gone (or
                // has left celld-vps): its fleet and data may still run on a box this
                // driver cannot name. Throwing keeps the row pending and the alias
                // claimed — releasing it would let another project claim the label and
                // land on the old fleet's data.
                throw new Error(
                    `alias "${reference.alias}" has no box this control plane can resolve; its fleet cannot be stopped, so the alias stays claimed`,
                );
            }

            // Nothing CAN be stopped on a revoked box: it is cut off, and its data is
            // the customer's bucket to keep or delete. Recorded, then released.
            if ("revoked" in box && box.revoked) {
                ports.onLog?.(`alias "${reference.alias}": box "${box.slug}" is revoked; its fleet and data stay on the machine, releasing the alias`);

                return;
            }

            // Reached only once the alias has no deployment left — an expired
            // preview or a deleted project (the teardown sweep) — so the data goes
            // too, exactly as a cloudflare-wfp teardown deletes its D1 and R2. A box
            // that is offline throws, which leaves the row pending for the next tick.
            await run(box, "destroy", { alias: reference.alias, deleteData: true, kind: "destroy" }, DESTROY_TIMEOUT_MS);
        },
        domains: {
            // A custom domain CNAMEs to the box itself; its Caddy terminates TLS (plan 458 W5).
            platformTargets: () => (ports.box === undefined ? [] : [`${ports.box.slug}.${ports.boxDomain}`]),
        },
        id: "celld-vps",
        logs: { kind: "otlp" },
        // Tenants answer on their public hostname; backups and the admin proxy reach them there.
        reach: (tenant) => tenantSender(tenant),
        route: async (hostname, lookup) => {
            const host = hostname.toLowerCase();
            const suffix = `.${ports.boxDomain.toLowerCase()}`;

            if (!host.endsWith(suffix)) {
                const resourceRef = await lookup.customDomain(host);

                return resourceRef !== null && (await lookup.live(resourceRef)) ? { resourceRef } : null;
            }

            const labels = host.slice(0, -suffix.length).split(".");
            const [alias, slug] = labels;

            if (labels.length !== 2 || !alias || !slug) {
                return null;
            }

            const box = ports.box?.slug === slug ? ports.box : await ports.boxForSlug(slug);

            return box && (await lookup.live(alias)) ? { resourceRef: alias } : null;
        },
        tenantUrl,
        unsupportedReasons: UNSUPPORTED_REASONS["celld-vps"],
        ...(usage ? { usage } : {}),
    };
};

/** The env slice the `celld-vps` driver reads. A `type` so the control plane's env types stay assignable to it. */
export type CelldVpsEnvironment = {
    /** The per-box session namespace (`BoxSessionDO`); absent → this control plane cannot reach boxes. */
    BOX_SESSION?: BoxSessionNamespace;
    DB?: unknown;
    LUNORA_BOX_DOMAIN?: string;
    /** This control plane's public origin — the base of every `releaseUrl` a box is handed. */
    LUNORA_ORIGIN_URL?: string;
} & BoxDnsEnvironment;

interface BoxRow {
    _id: string;
    slug: string;
    status: string;
}

const boxReference = (row: BoxRow | null | undefined): BoxReference | null => (row ? { id: row._id, revoked: row.status === "revoked", slug: row.slug } : null);

/** The box an alias is deployed to: alias → its owning project (`aliasOwnership`) → the project's box. */
export const boxForAliasIn =
    (database: ControlPlaneStore) =>
    async (alias: string): Promise<BoxReference | null> => {
        const { page: owners } = await database.findMany("aliasOwnership", { where: { alias } });
        const owner = owners[0] as undefined | { projectId: string };
        const project = owner ? ((await database.get(owner.projectId, "projects")) as null | { boxId?: null | string }) : null;

        return project?.boxId == null ? null : boxReference((await database.get(project.boxId, "boxes")) as BoxRow | null);
    };

/**
 * Box-reported request counts after `sinceMs`, per alias. Box rows carry the
 * report window they count, so the read is by window, never by when the row
 * was written — a late report lands in the window it measured.
 */
export const boxUsageIn =
    (database: ControlPlaneStore) =>
    async (sinceMs: number): Promise<UsageRow[]> => {
        const { page } = await database.findMany("platformUsage", { where: { kind: "requests", windowStart: { gt: sinceMs } } });
        const rows = (page as { boxId?: null | string; deploymentId?: null | string; quantity: number }[]).filter(
            (row) => row.boxId != null && row.deploymentId != null,
        );
        const aliases = new Map<string, string>();
        const totals = new Map<string, number>();

        for (const row of rows) {
            const deploymentId = row.deploymentId as string;

            if (!aliases.has(deploymentId)) {
                // eslint-disable-next-line no-await-in-loop -- one read per distinct deployment, cached
                const deployment = (await database.get(deploymentId, "deployments")) as null | { alias?: null | string; scriptName: string };

                aliases.set(deploymentId, deployment?.alias ?? deployment?.scriptName ?? "");
            }

            const alias = aliases.get(deploymentId) ?? "";

            if (alias !== "") {
                totals.set(alias, (totals.get(alias) ?? 0) + row.quantity);
            }
        }

        return [...totals].map(([resourceRef, requests]) => {
            return { requests, resourceRef };
        });
    };

/** Whether this control-plane deployment can converge and tear down `celld-vps` tenants. */
export const celldVpsCanConverge = (environment: CelldVpsEnvironment): boolean =>
    environment.BOX_SESSION != null && environment.DB != null && environment.LUNORA_ORIGIN_URL != null;

/** Build the driver off the Worker env. Lazy: nothing is touched until a member is called. */
export const celldVpsDriverFromEnv = (
    environment: CelldVpsEnvironment,
    options: { box?: BoxPlacement; onLog?: (line: string) => void; onProgress?: (line: string) => void } = {},
): TargetDriver => {
    const database = (): ControlPlaneStore => {
        if (environment.DB == null) {
            throw new Error("celld-vps needs the control-plane D1 (DB)");
        }

        return controlPlaneDatabase(environment.DB as D1DatabaseLike);
    };

    return createCelldVpsDriver({
        ...(options.box === undefined ? {} : { box: options.box }),
        boxDomain: boxDomainOf(environment),
        boxById: async (id) => boxReference((await database().get(id, "boxes")) as BoxRow | null),
        boxForAlias: (alias) => boxForAliasIn(database())(alias),
        boxForSlug: async (slug) => {
            const { page } = await database().findMany("boxes", { where: { slug } });

            return boxReference(page[0] as BoxRow | undefined);
        },
        controlPlaneOrigin: stripTrailingSlashes(environment.LUNORA_ORIGIN_URL ?? ""),
        ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        session: (boxId) => {
            if (!environment.BOX_SESSION) {
                throw new BoxSessionError("BOX_OFFLINE", "this control plane has no box sessions bound (BOX_SESSION)");
            }

            return boxSession(environment.BOX_SESSION, boxId);
        },
        usage: (sinceMs) => boxUsageIn(database())(sinceMs),
    });
};
