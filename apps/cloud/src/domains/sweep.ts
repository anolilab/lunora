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
import type { ControlPlaneDatabase } from "../store";
import { domainNotificationDetail, reconcileDomain } from "./check";
import { type DnsResolve, verifyDomain } from "./verify";

/** Domains checked per run. The DNS lookups for a batch run concurrently. */
export const DOMAIN_BATCH_SIZE = 50;

interface DomainRow {
    _id: string;
    failedChecks?: number;
    hostname: string;
    organizationId: string;
    projectId: string;
    txtToken: string;
    verifiedAt?: number;
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
    /** The platform's app domain, which a verified hostname must CNAME toward. */
    appDomain: string;
    now: number;
    resolve: DnsResolve;
}

export interface DomainSweepResult {
    checked: number;
    failed: number;
    verified: number;
}

/** Queue a domain transition for every enabled channel in the org that subscribes to it. */
const announce = async (
    database: ControlPlaneDatabase,
    domain: DomainRow,
    event: "domain.failed" | "domain.verified",
    now: number,
): Promise<void> => {
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
            const result = await verifyDomain(domain.hostname, {
                platformTargets: [options.appDomain],
                resolve: options.resolve,
                txtToken: domain.txtToken,
            });

            return { domain, verified: result.verified };
        }),
    );

    const result: DomainSweepResult = { checked: domains.length, failed: 0, verified: 0 };

    for (const { domain, verified } of verdicts) {
        const outcome = reconcileDomain(domain, verified, options.now);

        // eslint-disable-next-line no-await-in-loop -- one write per checked domain; the batch is small
        await database.patch(domain._id, { ...outcome.patch, lastCheckedAt: options.now, updatedAt: options.now }, "domains");

        if (outcome.transition !== null) {
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
