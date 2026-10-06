/**
 * Edge-block suspension on `cloudflare-wfp` (plan 365 W8, D11). A suspended
 * organization's 503 is served by the dispatch Worker, so every request of an
 * attack on it still bills a Workers-for-Platforms request plus CPU. This moves
 * the stop in front of the Worker, where a blocked request costs nothing:
 *
 * 1. **Hostname list** (`LUNORA_SUSPENDED_HOSTS_LIST_ID`, Enterprise-only): the
 *    suspended organizations' platform hostnames (`{alias}.{appDomain}`) and
 *    custom domains are kept in an account list that one operator-installed
 *    WAF rule blocks. Covers both kinds and keeps certificates intact.
 * 2. **Custom hostname removal** (any plan, needs the SaaS zone, and OPT-IN:
 *    `LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES=1`, see `src/domains/edge-block-mode.ts`):
 *    without the list, a suspended organization's custom domains have their Cloudflare-for-
 *    SaaS custom hostname deleted, so the edge stops the request with no rule
 *    at all, and recreated on recovery. Cloudflare has no API to deactivate a
 *    custom hostname in place, which is what D11 assumed; deletion is the
 *    nearest equivalent, and costs a certificate re-issue on recovery (HTTP DV,
 *    automatic while the customer's CNAME stays in place). Destructive to the
 *    customer's domains, which is why it is never the default: with neither
 *    the list nor the opt-in, nothing is blocked here and the 503 is the block.
 *
 * The dispatcher's 503 stays as the always-works fallback: platform hostnames
 * without the list, and every request before a block lands.
 *
 * Fail safe in both directions. Nothing here reads or writes the suspension
 * itself, so a failed block never un-suspends anything. A failed unblock keeps
 * its marker (`domains.edgeBlockedAt`) and its error (`edgeBlockError`, shown
 * on the domain) and is retried every tick. Each step is idempotent — a delete
 * of a gone hostname is done, a restore adopts the hostname an earlier
 * half-finished restore created — and every transition is audit-logged.
 *
 * Box (`celld-vps`) and connected-account (`cloudflare-workers`) tenants are
 * never touched: their traffic does not cross the platform's zone.
 */
import type { HostList } from "../../cloudflare/host-list";
import type { ControlPlaneStore } from "../../d1-store";
import { storedTarget } from "../../provision-contract";
import { drainTable } from "../../store";
import type { DomainCertificate, EdgeBlockResult } from "../driver";
import type { SaasZone } from "./certificates";
import { certificateOf } from "./certificates";

/** Custom hostnames removed or restored per tick, so a mass suspension cannot spend the cell's API budget in one go. */
export const MAX_HOSTNAME_OPS_PER_TICK = 50;

/** Hostnames queued onto the list per tick. */
export const MAX_LIST_ADDS_PER_TICK = 1000;

/** Longest error kept on a domain row. */
const MAX_ERROR = 256;

/** RFC 1035 hostname shape: what may go onto the list. */
const HOSTNAME = /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+$/u;

const SUSPENDED_CERTIFICATE_ERROR = "the organization is suspended; this hostname is blocked at the edge until it recovers";

export interface EdgeBlockPorts {
    /** The platform apex (`LUNORA_APP_DOMAIN`), for the platform hostnames. */
    appDomain: string;

    /**
     * Whether a suspended org's custom hostnames may be DELETED (the
     * `delete-hostnames` mode, opted in with `LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES=1`).
     * Off, nothing is deleted; rows an earlier opt-in blocked are still restored.
     */
    deleteHostnames: boolean;
    /** The suspended-hostnames list, where the operator configured one. */
    hostList?: HostList;
    log: (line: string) => void;
    now: number;
    /** This cell's SaaS zone, where custom-domain certificates live. */
    zone?: SaasZone;
}

interface OrganizationRow {
    _id: string;
    suspendedAt?: null | number;
}

interface DomainRow {
    _id: string;
    certificateIssuer?: null | string;
    certificateScope?: null | string;
    customHostnameId?: null | string;
    edgeBlockedAt?: null | number;
    edgeBlockError?: null | string;
    hostname: string;
    organizationId: string;
    verifiedAt?: null | number;
}

interface DeploymentRow {
    alias?: null | string;
    organizationId: string;
    scriptName: string;
    status: string;
    target?: null | string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR);

/** Whether a domain's certificate is this zone's — the only custom hostnames this cell may remove or recreate. */
const inZone = (row: DomainRow, zone: SaasZone): boolean => row.certificateIssuer === "cloudflare-wfp" && row.certificateScope === zone.zoneId;

const audit = async (database: ControlPlaneStore, now: number, organizationId: string, action: string, target: string): Promise<void> => {
    await database.insert("auditLog", { action, actorUserId: "system:edge-block", createdAt: now, organizationId, target: target.slice(0, MAX_ERROR) });
};

/**
 * Record a failed step on the row and log it; audit only the first failure of a
 * run of them, so a persistent error is visible without an audit row an hour.
 */
const recordFailure = async (database: ControlPlaneStore, ports: EdgeBlockPorts, row: DomainRow, action: string, error: unknown): Promise<void> => {
    const message = messageOf(error);
    const firstFailure = row.edgeBlockError == null;

    ports.log(`[edge-block] ${action} failed for domain ${row._id}: ${message}`);
    await database.patch(row._id, { edgeBlockError: message, updatedAt: ports.now }, "domains").catch(() => undefined);

    if (firstFailure) {
        await audit(database, ports.now, row.organizationId, `domain.${action}_failed`, `${row.hostname}: ${message}`).catch(() => undefined);
    }
};

/**
 * Re-read the domain and its organization at the moment of the call, and
 * confirm the mapping the tick planned from still holds: the row still exists
 * with the same hostname and organization, it is still the ONLY row for that
 * hostname, the organization is still in the state the step acts on, and the
 * certificate is still this zone's. Anything else — the domain removed and
 * re-added, moved to another org, the suspension lifted mid-tick — throws, so
 * the step writes nothing and the next tick plans again from fresh rows.
 */
const confirmedRow = async (database: ControlPlaneStore, zone: SaasZone, planned: DomainRow, suspended: boolean): Promise<DomainRow> => {
    const current = (await database.get(planned._id, "domains")) as DomainRow | null;
    const organization = current === null ? null : ((await database.get(current.organizationId, "organizations")) as OrganizationRow | null);
    const { page: owners } = await database.findMany("domains", { where: { hostname: planned.hostname } });

    if (
        current?.hostname !== planned.hostname ||
        current.organizationId !== planned.organizationId ||
        organization === null ||
        (organization.suspendedAt != null) !== suspended ||
        owners.length !== 1 ||
        (owners[0] as DomainRow)._id !== planned._id ||
        !inZone(current, zone)
    ) {
        throw new Error(`domain ${planned._id} changed since this tick read it (removed, re-added, reassigned or recovered); nothing was written`);
    }

    return current;
};

/**
 * Remove a suspended organization's custom hostname. The id is confirmed twice
 * before the delete: it is still the one on the current row, and Cloudflare
 * still maps it to this row's hostname — a recycled or reassigned id is never
 * deleted. Done when it is already gone.
 */
const blockHostname = async (database: ControlPlaneStore, ports: EdgeBlockPorts, zone: SaasZone, planned: DomainRow): Promise<void> => {
    const row = await confirmedRow(database, zone, planned, true);
    const id = row.customHostnameId;

    if (id == null || id !== planned.customHostnameId) {
        throw new Error(`domain ${row._id}'s custom hostname changed since this tick read it; nothing was written`);
    }

    const live = await zone.api.getCustomHostname({ id, zoneId: zone.zoneId });

    if (live !== null && live.hostname.toLowerCase() !== row.hostname) {
        throw new Error(`custom hostname ${id} serves ${live.hostname}, not ${row.hostname}; refusing to delete it`);
    }

    if (live !== null) {
        await zone.api.deleteCustomHostname({ id, zoneId: zone.zoneId });
    }

    // The issuer and scope stay recorded: they are where the restore recreates it.
    await database.patch(
        row._id,
        {
            certificateError: SUSPENDED_CERTIFICATE_ERROR,
            certificateStatus: "suspended",
            customHostnameId: null,
            edgeBlockedAt: ports.now,
            edgeBlockError: null,
            updatedAt: ports.now,
        },
        "domains",
    );
    await audit(database, ports.now, row.organizationId, "domain.edge_block", `${row.hostname} (custom hostname ${id})`);
};

/**
 * Recreate a recovered organization's custom hostname, adopting one an earlier
 * half-finished restore created — only when no other domain row names it and
 * it is not queued for release (a removed domain's), either of which would put
 * one tenant's certificate under another's row.
 */
const unblockHostname = async (database: ControlPlaneStore, ports: EdgeBlockPorts, zone: SaasZone, planned: DomainRow): Promise<void> => {
    const row = await confirmedRow(database, zone, planned, false);

    if (row.edgeBlockedAt == null) {
        throw new Error(`domain ${row._id} is no longer edge-blocked; nothing was written`);
    }

    let certificate: DomainCertificate | undefined;

    if (row.verifiedAt != null) {
        const existing = await zone.api.findCustomHostname({ hostname: row.hostname, zoneId: zone.zoneId });

        if (existing !== null) {
            const [{ page: queued }, { page: claimed }] = await Promise.all([
                database.findMany("certificateReleases", { where: { customHostnameId: existing.id } }),
                database.findMany("domains", { where: { customHostnameId: existing.id } }),
            ]);

            if (queued.length > 0 || claimed.some((other) => (other as DomainRow)._id !== row._id)) {
                throw new Error(`custom hostname ${existing.id} for ${row.hostname} belongs to another domain row or is queued for release; not adopting it`);
            }
        }

        const restored = existing ?? (await zone.api.createCustomHostname({ hostname: row.hostname, zoneId: zone.zoneId }));

        if (restored.hostname.toLowerCase() !== row.hostname) {
            throw new Error(`Cloudflare answered custom hostname ${restored.id} for ${restored.hostname}, not ${row.hostname}; not recording it`);
        }

        certificate = certificateOf(zone, restored);
    }

    await database.patch(
        row._id,
        {
            ...(certificate === undefined
                ? { certificateError: null, certificateStatus: "unverified" }
                : { certificateError: certificate.error ?? null, certificateStatus: certificate.sslStatus, customHostnameId: certificate.customHostnameId }),
            edgeBlockedAt: null,
            edgeBlockError: null,
            updatedAt: ports.now,
        },
        "domains",
    );
    await audit(
        database,
        ports.now,
        row.organizationId,
        "domain.edge_unblock",
        certificate?.customHostnameId === undefined ? row.hostname : `${row.hostname} (custom hostname ${certificate.customHostnameId})`,
    );
};

/** Rung 2: remove suspended organizations' custom hostnames (only without the list), restore recovered ones (always). */
const reconcileCustomHostnames = async (
    database: ControlPlaneStore,
    ports: EdgeBlockPorts,
    zone: SaasZone,
    domains: ReadonlyArray<DomainRow>,
    suspended: ReadonlySet<string>,
): Promise<EdgeBlockResult> => {
    const result: EdgeBlockResult = { blocked: 0, failed: 0, unblocked: 0 };
    const toBlock =
        ports.hostList === undefined && ports.deleteHostnames
            ? domains.filter((row) => suspended.has(row.organizationId) && row.customHostnameId != null && inZone(row, zone))
            : [];
    // A row blocked before the list was configured is still restored here.
    const toUnblock = domains.filter((row) => !suspended.has(row.organizationId) && row.edgeBlockedAt != null && inZone(row, zone));
    // Blocks first: stopping a billed attack outranks restoring service by a tick.
    const due = [
        ...toBlock.map((row) => {
            return { block: true, row };
        }),
        ...toUnblock.map((row) => {
            return { block: false, row };
        }),
    ].slice(0, MAX_HOSTNAME_OPS_PER_TICK);

    for (const { block, row } of due) {
        try {
            // eslint-disable-next-line no-await-in-loop -- bounded batch; one API call at a time keeps the cell's API budget flat
            await (block ? blockHostname(database, ports, zone, row) : unblockHostname(database, ports, zone, row));
            result[block ? "blocked" : "unblocked"] += 1;
        } catch (error) {
            result.failed += 1;
            // eslint-disable-next-line no-await-in-loop -- one row per failure
            await recordFailure(database, ports, row, block ? "edge_block" : "edge_unblock", error);
        }
    }

    return result;
};

/**
 * Every hostname each organization serves through this zone: its live platform
 * aliases and its verified custom domains, read this tick. A hostname that
 * more than one organization's rows name is left out entirely: listing it
 * could block a tenant that is not suspended, and the dispatcher's 503 still
 * holds for the one that is.
 */
const hostnamesByOrganization = (domains: ReadonlyArray<DomainRow>, deployments: ReadonlyArray<DeploymentRow>, appDomain: string): Map<string, string> => {
    const owner = new Map<string, string>();
    const ambiguous = new Set<string>();
    const claim = (hostname: string, organizationId: string): void => {
        const known = owner.get(hostname);

        if (known !== undefined && known !== organizationId) {
            ambiguous.add(hostname);
        }

        owner.set(hostname, organizationId);
    };

    for (const row of deployments) {
        if (row.status !== "destroyed" && storedTarget(row.target) === "cloudflare-wfp") {
            claim(`${row.alias ?? row.scriptName}.${appDomain}`.toLowerCase(), row.organizationId);
        }
    }

    for (const row of domains) {
        if (row.verifiedAt != null && row.certificateIssuer === "cloudflare-wfp") {
            claim(row.hostname.toLowerCase(), row.organizationId);
        }
    }

    for (const hostname of owner.keys()) {
        if (ambiguous.has(hostname) || !HOSTNAME.test(hostname)) {
            owner.delete(hostname);
        }
    }

    return owner;
};

/**
 * Rung 1: converge the list to the suspended organizations' hostnames. Cloudflare
 * runs one bulk list operation per account at a time, so a tick that adds does
 * not also remove.
 *
 * ponytail: unblocks wait a tick behind any pending block; one bulk op per tick
 * is the ceiling, poll `operation_id` if recovery latency starts to matter.
 */
const reconcileHostList = async (
    database: ControlPlaneStore,
    ports: EdgeBlockPorts,
    hostList: HostList,
    owner: ReadonlyMap<string, string>,
    suspended: ReadonlySet<string>,
): Promise<EdgeBlockResult> => {
    const desired = new Set([...owner].flatMap(([hostname, organizationId]) => (suspended.has(organizationId) ? [hostname] : [])));
    const { items, truncated } = await hostList.items();
    const present = new Set(items.map((item) => item.hostname));
    const toAdd = [...desired].filter((hostname) => !present.has(hostname)).slice(0, MAX_LIST_ADDS_PER_TICK);
    // A truncated read cannot prove an item unwanted: removing on it could unblock a suspended org.
    const toRemove = truncated ? [] : items.filter((item) => !desired.has(item.hostname));

    if (truncated) {
        ports.log("[edge-block] the suspended-hostnames list read was truncated; removals are skipped this tick");
    }

    const auditEach = async (hostnames: ReadonlyArray<string>, action: string): Promise<void> => {
        const byOrganization = new Map<string, string[]>();

        for (const hostname of hostnames) {
            const organizationId = owner.get(hostname);

            if (organizationId !== undefined) {
                byOrganization.set(organizationId, [...(byOrganization.get(organizationId) ?? []), hostname]);
            }
        }

        for (const [organizationId, names] of byOrganization) {
            // eslint-disable-next-line no-await-in-loop -- one audit row per organization
            await audit(database, ports.now, organizationId, action, names.join(", "));
        }
    };

    if (toAdd.length > 0) {
        await hostList.add(toAdd);
        await auditEach(toAdd, "organization.edge_block");

        return { blocked: toAdd.length, failed: 0, unblocked: 0 };
    }

    if (toRemove.length > 0) {
        await hostList.remove(toRemove.map((item) => item.id));
        await auditEach(
            toRemove.map((item) => item.hostname),
            "organization.edge_unblock",
        );
    }

    return { blocked: 0, failed: 0, unblocked: toRemove.length };
};

/** One tick: converge the edge to the suspensions recorded in the control plane. */
export const reconcileEdgeBlocks = async (database: ControlPlaneStore, ports: EdgeBlockPorts): Promise<EdgeBlockResult> => {
    const result: EdgeBlockResult = { blocked: 0, failed: 0, unblocked: 0 };

    if (ports.zone === undefined && ports.hostList === undefined) {
        return result;
    }

    const organizations = await drainTable<OrganizationRow>(database, "organizations");
    const suspended = new Set(organizations.filter((row) => row.suspendedAt != null).map((row) => row._id));
    const domains = await drainTable<DomainRow>(database, "domains");
    const add = (part: EdgeBlockResult): void => {
        result.blocked += part.blocked;
        result.failed += part.failed;
        result.unblocked += part.unblocked;
    };

    if (ports.hostList !== undefined) {
        const deployments = await drainTable<DeploymentRow>(database, "deployments");

        try {
            add(await reconcileHostList(database, ports, ports.hostList, hostnamesByOrganization(domains, deployments, ports.appDomain), suspended));
        } catch (error) {
            // Retried next tick from a fresh diff; the dispatcher's 503 holds meanwhile.
            result.failed += 1;
            ports.log(`[edge-block] suspended-hostnames list update failed: ${messageOf(error)}`);
        }
    }

    if (ports.zone !== undefined) {
        add(await reconcileCustomHostnames(database, ports, ports.zone, domains, suspended));
    }

    return result;
};
