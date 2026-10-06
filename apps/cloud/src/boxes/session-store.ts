/**
 * What a box session writes to the control plane (plan 458 G11): the box's
 * liveness and what its `hostd` reported, on its `boxes` row.
 *
 * Direct writes to the `.global()` store, not mutations: the session lives in a
 * Durable Object outside any Lunora request, the same trusted system context
 * the scheduled sweeps write from (`src/server.ts`). A revoked row is never
 * moved back to `online` or `offline` — revocation is final.
 */
import { isReleaseAlias } from "@lunora/config/celld";

import type { AdmissionRow } from "../billing/spend";
import { organizationServing } from "../billing/spend";
import type { ControlPlaneStore } from "../d1-store";
import type { BoxResources, BoxVersions, FleetSummary, RouteEntry } from "../hostd/protocol";
import { HOSTD_PROTOCOL_LIMITS, isHostname } from "../hostd/protocol";
import { normaliseFleets } from "./fleets";
import type { SessionBox } from "./session";

/** The `boxes` columns a session reads. `.global()` rows answer SQL NULL for an unset column. */
export interface StoredBox {
    _id: string;
    allowDowngrade?: boolean | null;
    desiredReleaseId?: null | string;
    fleets?: FleetSummary[] | null;
    organizationId: string;
    publicKey: string;
    slug: string;
    status: "offline" | "online" | "pending" | "revoked";
}

/** Only write `lastSeenAt` this often for a box that is merely alive: pongs arrive every 30 s, D1 writes need not. */
export const SEEN_WRITE_INTERVAL_MS = 60_000;

export const loadBox = async (database: ControlPlaneStore, boxId: string): Promise<null | StoredBox> =>
    (await database.get(boxId, "boxes")) as null | StoredBox;

/** The identity half of a box, as the handshake checks it. */
export const sessionBoxOf = (box: null | StoredBox): null | SessionBox =>
    box === null ? null : { publicKey: box.publicKey, revoked: box.status === "revoked" };

/**
 * Record an authenticated `hello`: the box is online, runs these versions with
 * this much room — and these fleets, when the session still held them (it holds
 * them in memory between `hello` and `auth`, so an eviction in between loses
 * them; the stored list then stays until the next job or `hello` moves it).
 */
export const recordHello = async (
    database: ControlPlaneStore,
    boxId: string,
    hello: { fleets?: FleetSummary[]; resources: BoxResources; versions: BoxVersions },
    now: number,
): Promise<void> => {
    const box = await loadBox(database, boxId);

    if (box === null || box.status === "revoked") {
        return;
    }

    await database.patch(
        boxId,
        {
            ...(hello.fleets === undefined ? {} : { fleets: normaliseFleets(hello.fleets) }),
            lastSeenAt: now,
            resources: hello.resources,
            status: "online",
            versions: hello.versions,
        },
        "boxes",
    );
};

/**
 * Move a box's stored fleets on after a job finished (`fleetsAfterJob`):
 * `update` maps what is stored to what should be, or `undefined` to leave it.
 * A revoked or vanished box is not written to.
 */
export const updateFleets = async (
    database: ControlPlaneStore,
    boxId: string,
    update: (fleets: FleetSummary[]) => FleetSummary[] | undefined,
): Promise<void> => {
    const box = await loadBox(database, boxId);

    if (box === null || box.status === "revoked") {
        return;
    }

    const next = update(box.fleets ?? []);

    if (next !== undefined) {
        await database.patch(boxId, { fleets: next }, "boxes");
    }
};

/** Record that an authenticated box is still there. */
export const markSeen = async (database: ControlPlaneStore, boxId: string, now: number): Promise<void> => {
    await database.patch(boxId, { lastSeenAt: now }, "boxes");
};

/** Record that a box's session ended: an `online` box is offline until it authenticates again. Any other status stays. */
export const markOffline = async (database: ControlPlaneStore, boxId: string): Promise<void> => {
    const box = await loadBox(database, boxId);

    if (box?.status !== "online") {
        return;
    }

    await database.patch(boxId, { status: "offline" }, "boxes");
};

/**
 * The deployments a box routes: live ones, and those being converged or
 * health-checked — the health check reaches the tenant through its hostname,
 * so the route must exist before the release goes live.
 */
const ROUTED_STATUSES: ReadonlySet<string> = new Set(["live", "provisioning", "verifying"]);

interface ProjectRow {
    _id: string;
    activeScriptName?: null | string;
    organizationId: string;
}

interface DomainRow {
    hostname: string;
    redirectTo?: null | string;
    verifiedAt?: null | number;
}

/** The `hostname → alias` routes of one project: its live aliases at the box's default hostname, and its verified custom domains. */
const projectRoutes = async (database: ControlPlaneStore, project: ProjectRow, defaultHost: (alias: string) => string): Promise<[string, string][]> => {
    const { _id: projectId } = project;
    const [{ page: deployments }, { page: domains }] = await Promise.all([
        database.findMany("deployments", { where: { projectId } }),
        database.findMany("domains", { where: { projectId } }),
    ]);
    const routes: [string, string][] = [];

    for (const { alias, status } of deployments as { alias?: null | string; status: string }[]) {
        if (alias != null && ROUTED_STATUSES.has(status) && isReleaseAlias(alias) && isHostname(defaultHost(alias))) {
            routes.push([defaultHost(alias), alias]);
        }
    }

    const production = project.activeScriptName;

    if (production == null || !isReleaseAlias(production)) {
        return routes;
    }

    // Redirect-only domains route nowhere; an unverified one has not proven it points here.
    for (const domain of domains as DomainRow[]) {
        if (domain.verifiedAt != null && domain.redirectTo == null && isHostname(domain.hostname)) {
            routes.push([domain.hostname, production]);
        }
    }

    return routes;
};

/**
 * The projects placed on a box, split by whether their organization may serve
 * (`organizationServing`, read from each organization's row at call time): a
 * suspended org, one refused at admission for breaching its cap (plan 365 W3),
 * or one whose row is gone is `withheld` — its ids sorted, so two reads compare.
 */
export const boxProjects = async (database: ControlPlaneStore, boxId: string, now: number): Promise<{ serving: ProjectRow[]; withheld: string[] }> => {
    const { page } = await database.findMany("projects", { where: { placementRef: boxId } });
    const projects = page as ProjectRow[];
    const organizationIds = [...new Set(projects.map((project) => project.organizationId))];
    // An organization whose row cannot be read is treated as not serving: unknown state fails closed,
    // and the next push (the suspension sweep retries every minute) reads it again.
    const rows = await Promise.all(organizationIds.map(async (id) => (await database.get(id, "organizations").catch(() => null)) as AdmissionRow | null));
    const withheld = new Set(organizationIds.filter((_id, index) => !organizationServing(rows[index] ?? null, now)));

    return { serving: projects.filter((project) => !withheld.has(project.organizationId)), withheld: [...withheld].toSorted((a, b) => a.localeCompare(b)) };
};

/**
 * The full routing table a box serves (`routes` frame): every routed alias of the
 * projects placed on it, at its default hostname `{alias}.{slug}.{boxDomain}`,
 * plus each verified custom domain of those projects, pointed at the project's
 * production alias. Capped at the protocol's table size; hostnames unique.
 *
 * A suspended or over-cap organization's projects are left out (`withheld`), so
 * the box stops their fleets — it stops a fleet the table no longer names and
 * never deletes one — until a later push names them again. Every push reads the
 * suspension afresh: the routine ones, a reconnect, and the suspension sweep's.
 */
export const routesForBox = async (
    database: ControlPlaneStore,
    box: { _id: string; slug: string },
    boxDomain: string,
    now: number,
): Promise<{ table: RouteEntry[]; withheld: string[] }> => {
    const { serving, withheld } = await boxProjects(database, box._id, now);
    const perProject = await Promise.all(
        serving.map((project) => projectRoutes(database, project, (alias) => `${alias}.${box.slug}.${boxDomain}`.toLowerCase())),
    );
    const table = new Map(perProject.flat());

    return {
        table: [...table]
            .toSorted(([a], [b]) => (a < b ? -1 : 1))
            .slice(0, HOSTD_PROTOCOL_LIMITS.maxRoutes)
            .map(([hostname, alias]) => {
                return { alias, hostname };
            }),
        withheld,
    };
};
