/**
 * The scheduled custom-domain check. Runs from the control plane's hourly
 * `scheduled()` tick: re-runs the same DNS verification the manual Verify button
 * uses, writes back the reconciled state, and announces a transition (verified,
 * or failed after repeated misses) to the org's subscribed channels. Domains are
 * read oldest-checked first, so a large fleet is covered across successive runs.
 */
import type { NotificationEvent, NotificationKind } from "../notifications/events";
import { channelsForEvent, renderNotification } from "../notifications/events";
import { pendingDeliveryRow } from "../notifications/outbox";
import { storedTarget } from "../provision-contract";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { DomainOps } from "../targets/driver";
import type { Placement } from "../targets/placement";
import { placementOfDeployment, storeRowReader } from "../targets/placement";
import { domainNotificationDetail, reconcileDomain } from "./check";
import type { DnsResolve } from "./verify";
import { verifyDomain } from "./verify";

/** Domains checked per run. The DNS lookups for a batch run concurrently. */
export const DOMAIN_BATCH_SIZE = 50;

/** A custom domain still unverified this long after it was added is removed. */
export const UNVERIFIED_DOMAIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface DomainRow {
    _id: string;
    createdAt?: number;
    customHostnameId?: null | string;
    failedChecks?: number;
    hostname: string;
    organizationId: string;
    projectId: string;
    txtToken: string;
    verifiedAt?: null | number;
}

interface ChannelRow {
    _id: string;
    enabled: boolean;
    events: NotificationEvent[];
    kind: NotificationKind;
}

interface ProjectRow {
    _id: string;
    name?: string;
}

export interface DomainSweepOptions {
    /**
     * Tell project `projectId`'s placement its domains changed, as the domain routes do. A box
     * serves the custom domains its pushed routing table names, so without this a domain the
     * sweep verified or failed stayed served as before until something else pushed routes.
     */
    domainsChanged?: (projectId: string) => Promise<void>;
    now: number;

    /**
     * The CNAME targets a domain of project `projectId` must point at — its placement's, as the
     * Verify button checks them — or `undefined` when the project is not placed anywhere reachable.
     */
    platformTargets: (projectId: string) => Promise<ReadonlyArray<string> | undefined>;
    resolve: DnsResolve;
}

/**
 * The sweep's `platformTargets` over the control-plane rows: the project's placement, then
 * its driver's targets. A box-hosted domain points at the box, not the cell apex, so
 * checking every domain against the apex failed each one of those.
 */
type ProjectRowReader = { get: (table: string, id: string) => Promise<unknown> };

type DriverFor = (placement: Placement) => { domains: Pick<DomainOps, "domainsChanged" | "platformTargets"> };

/** The domain operations of project `projectId`'s placement, or `undefined` when it is not placed anywhere reachable. */
const projectDomainOps = async (
    database: ProjectRowReader,
    driverFor: DriverFor,
    projectId: string,
): Promise<Pick<DomainOps, "domainsChanged" | "platformTargets"> | undefined> => {
    const project = (await database.get("projects", projectId)) as null | { placementRef?: null | string; target?: null | string };
    const target = project === null ? undefined : storedTarget(project.target);

    if (project === null || target === undefined) {
        return undefined;
    }

    const placed = await placementOfDeployment({ placementRef: project.placementRef, target }, storeRowReader(database));

    return "placement" in placed ? driverFor(placed.placement).domains : undefined;
};

export const projectPlatformTargets =
    (database: ProjectRowReader, driverFor: DriverFor) =>
    async (projectId: string): Promise<ReadonlyArray<string> | undefined> => {
        const ops = await projectDomainOps(database, driverFor, projectId);

        return ops?.platformTargets();
    };

/** The sweep's `domainsChanged` over the control-plane rows, resolving the placement as {@link projectPlatformTargets} does. */
export const projectDomainsChanged =
    (database: ProjectRowReader, driverFor: DriverFor) =>
    async (projectId: string): Promise<void> => {
        const ops = await projectDomainOps(database, driverFor, projectId);

        await ops?.domainsChanged?.();
    };

export interface DomainSweepResult {
    checked: number;
    failed: number;
    verified: number;
}

/** Queue a domain transition for every enabled channel in the org that subscribes to it. */
const announce = async (database: ControlPlaneDatabase, domain: DomainRow, event: "domain.failed" | "domain.verified", now: number): Promise<void> => {
    const { page: channelPage } = await database.findMany("notificationChannels", { where: { organizationId: domain.organizationId } });
    const targets = channelsForEvent(channelPage as unknown as ChannelRow[], event);

    if (targets.length === 0) {
        return;
    }

    const { page: projectPage } = await database.findMany("projects", { where: { organizationId: domain.organizationId } });
    const project = (projectPage as unknown as ProjectRow[]).find((candidate) => candidate._id === domain.projectId);
    const message = renderNotification(event, { detail: domainNotificationDetail(event, domain.hostname), project: project?.name ?? "project" });

    for (const channel of targets) {
        // eslint-disable-next-line no-await-in-loop -- a handful of channels per transition; sequential keeps the writes simple
        await database.insert("notificationDeliveries", pendingDeliveryRow(channel, message, domain.organizationId, now));
    }
};

/** Tell a domain's placement its domains changed, best-effort: the state is already written. */
const tellPlacement = async (options: DomainSweepOptions, domain: DomainRow): Promise<void> => {
    try {
        await options.domainsChanged?.(domain.projectId);
    } catch (error) {
        // eslint-disable-next-line no-console -- the state is written; the box catches up on its next push or reconnect
        console.warn("[domains]", `${domain.hostname} changed, but its target could not be told: ${error instanceof Error ? error.message : String(error)}`);
    }
};

/**
 * Remove the custom domains that were added and never verified within
 * {@link UNVERIFIED_DOMAIN_TTL_MS}. A domain with a certificate is never removed
 * here: releasing a certificate goes through the `domains.remove` path, which this
 * sweep does not take. Limit: `verifiedAt` clears when a verified domain stops
 * validating, so such a domain with no certificate reads as unverified and is
 * removed too; the row does not record that it ever verified.
 */
export const expireUnverifiedDomains = async (database: ControlPlaneDatabase, options: { now: number }): Promise<{ expired: number }> => {
    const domains = await drainTable<DomainRow>(database, "domains");
    const cutoff = options.now - UNVERIFIED_DOMAIN_TTL_MS;
    const expired = domains.filter(
        (domain) => domain.createdAt !== undefined && domain.createdAt < cutoff && domain.verifiedAt == null && domain.customHostnameId == null,
    );

    for (const domain of expired) {
        // eslint-disable-next-line no-await-in-loop -- expiries are rare; sequential keeps the writes simple
        await database.delete("domains", domain._id);
    }

    return { expired: expired.length };
};

/**
 * Run one domain check. Verdicts are gathered concurrently, then each domain's
 * state is reconciled and written back. `updatedAt` is stamped on every check,
 * which is what rotates the oldest-checked-first order.
 */
export const runDomainSweep = async (database: ControlPlaneDatabase, options: DomainSweepOptions): Promise<DomainSweepResult> => {
    const { page } = await database.findMany("domains", { limit: DOMAIN_BATCH_SIZE, orderBy: [{ updatedAt: "asc" }] });
    const domains = page as unknown as DomainRow[];

    const verdicts = await Promise.all(
        domains.map(async (domain) => {
            const platformTargets = await options.platformTargets(domain.projectId).catch(() => undefined);

            // No placement to check against: an empty target list would accept any CNAME, and the
            // apex would fail a box-hosted domain, so neither verdict is honest. Skipped this tick.
            if (platformTargets === undefined) {
                return { domain, verified: undefined };
            }

            const result = await verifyDomain(domain.hostname, { platformTargets, resolve: options.resolve, txtToken: domain.txtToken });

            return { domain, verified: result.verified };
        }),
    );

    const result: DomainSweepResult = { checked: domains.length, failed: 0, verified: 0 };

    for (const { domain, verified } of verdicts) {
        if (verified === undefined) {
            // Stamped all the same, so an unplaced domain rotates to the back rather than holding the batch.
            // eslint-disable-next-line no-await-in-loop -- one write per checked domain; the batch is small
            await database.patch("domains", domain._id, { updatedAt: options.now });
            continue;
        }

        const outcome = reconcileDomain(domain, verified, options.now);

        // eslint-disable-next-line no-await-in-loop -- one write per checked domain; the batch is small
        await database.patch("domains", domain._id, { ...outcome.patch, lastCheckedAt: options.now, updatedAt: options.now });

        if (outcome.transition !== null) {
            // A transition is exactly when `verifiedAt` changed, which is what decides whether a box serves the hostname.
            // eslint-disable-next-line no-await-in-loop -- transitions are rare; one push per changed domain
            await tellPlacement(options, domain);

            // eslint-disable-next-line no-await-in-loop -- transitions are rare; sequential keeps the writes simple
            await announce(database, domain, outcome.transition, options.now);

            if (outcome.transition === "domain.verified") {
                result.verified += 1;
            } else {
                result.failed += 1;
            }
        }
    }

    return result;
};
