/**
 * Edge protection (plan 365 W7, D9), target-neutral half: the settings an
 * organization may choose, the bounds on them, which of its hostnames a
 * target's edge fronts, and the {@link EdgeProtection} port a target's fleet
 * offers (`TargetFleet.edge`). Only `cloudflare-wfp` offers one today
 * (`src/targets/cloudflare-wfp/edge.ts`); every other target answers
 * "unsupported" by not having it, and the reads name those projects.
 */

/** The edge rules one organization can hold, one of each. */
export type EdgeRuleKind = "ddos_l7" | "rate_limit";

/** The sensitivity levels an organization may choose. `eoff` (essentially off) is deliberately not one of them. */
export type DdosSensitivity = "default" | "low" | "medium";

/** Rate-limit periods (seconds) accepted on every plan that allows host-scoped rules. */
export const RATE_LIMIT_PERIODS = [10, 60] as const;

/** Bounds on a rate-limit threshold, per period. */
export const RATE_LIMIT_REQUESTS = { max: 1_000_000, min: 10 } as const;

/** Hostnames one rule covers at most; past it the rule is refused rather than silently partial. */
export const MAX_EDGE_HOSTNAMES = 50;

/** The longest window one firewall read covers: the shortest retention any plan offers the dataset. */
export const MAX_FIREWALL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Firewall events one read returns at most. */
export const MAX_FIREWALL_EVENTS = 100;

/** The configuration an edge rule carries. */
export type EdgeRuleConfig =
    | { kind: "ddos_l7"; sensitivity: Exclude<DdosSensitivity, "default"> }
    | { kind: "rate_limit"; periodSeconds: (typeof RATE_LIMIT_PERIODS)[number]; requestsPerPeriod: number };

/** One firewall event as the console shows it — no client IP, bounded strings. */
export interface FirewallEvent {
    action: string;
    country: string;
    datetime: string;
    host: string;
    path: string;
    source: string;
}

/** What a firewall read answers: events, or why there are none. Never throws. */
export type FirewallEventsResult = { events: FirewallEvent[]; status: "ok" } | { events: []; reason: string; status: "unavailable" | "unconfigured" };

/** What a target's edge can do for an organization's hostnames. */
export interface EdgeProtection {
    /**
     * Make the edge hold exactly this organization's rule of `kind` over
     * `hostnames`, or none when `config` is `null` or there are no hostnames.
     * Idempotent, so a retry after a crash converges rather than duplicates.
     */
    apply: (input: {
        config: EdgeRuleConfig | null;
        hostnames: ReadonlyArray<string>;
        kind: EdgeRuleKind;
        organizationId: string;
    }) => Promise<{ ruleId?: string }>;
    /** The edge's firewall events on `hostnames` over `[from, to]`, newest first. */
    firewallEvents: (input: { from: number; hostnames: ReadonlyArray<string>; to: number }) => Promise<FirewallEventsResult>;
}

/** A DNS hostname, lowercase, at least two labels, no wildcard — the only shape that may enter an edge rule. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether `value` is a hostname that may enter an edge rule. */
export const isEdgeHostname = (value: string): boolean => HOSTNAME.test(value);

/** Valid, de-duplicated, sorted hostnames — sorted so an unchanged set compares equal and re-applies as a no-op. */
export const edgeHostnames = (candidates: ReadonlyArray<string>): string[] =>
    [...new Set(candidates.map((candidate) => candidate.toLowerCase()).filter((candidate) => isEdgeHostname(candidate)))].toSorted((a, b) =>
        a.localeCompare(b),
    );

/**
 * How many rules of a kind this cell may hold, from operator config
 * (`LUNORA_DDOS_OVERRIDE_BUDGET`, `LUNORA_RATE_LIMIT_RULE_BUDGET`). Unset or
 * malformed is 0: the feature is off until an operator states what the zone's
 * plan allows. Capped at Cloudflare's own Enterprise ceiling.
 */
export const edgeBudget = (value: string | undefined): number => {
    const parsed = Number(value);

    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 0;
};

/**
 * One hostname an edge rule covers, bound to the row that gives the organization
 * the right to it: a live deployment (its alias) or a verified custom domain.
 * An applied rule stores these, so the reconciler can tell when a row went away,
 * moved project, or was re-created under another organization, and take the
 * hostname off the rule.
 */
export interface EdgeTarget {
    hostname: string;
    projectId: string;
    rowId: string;
    source: "deployment" | "domain";
}

/** Hostnames an organization serves through the platform edge, and the projects that are not served there. */
export interface OrganizationHostnames {
    hostnames: string[];
    /** {@link hostnames}, each with the row it comes from, sorted by hostname then row. */
    targets: EdgeTarget[];
    /** Projects whose traffic never crosses the platform edge, so no firewall event or edge rule can see them. */
    unsupported: { name: string; reason: string; target: string }[];
}

const UNSUPPORTED_REASON: Record<string, string> = {
    "celld-vps": "served from the customer's own box, which the platform's Cloudflare edge does not front",
    "cloudflare-workers": "served from the customer's own Cloudflare account, whose zone the platform does not manage",
};

/**
 * The hostnames of `organizationId` on the platform edge, from its own rows:
 * `{alias}.{appDomain}` of each live `cloudflare-wfp` deployment (the
 * dispatcher's hostname grammar) and each verified, routing custom domain of a
 * `cloudflare-wfp` project. Rows of another organization are ignored even if
 * passed, so the caller's query shape is not the only fence.
 */
export const organizationHostnames = (input: {
    appDomain: string;
    deployments: ReadonlyArray<{ _id: string; alias?: null | string; organizationId: string; projectId: string; scriptName: string; status: string }>;
    domains: ReadonlyArray<{
        _id: string;
        hostname: string;
        organizationId: string;
        projectId: string;
        redirectTo?: null | string;
        verifiedAt?: null | number;
    }>;
    organizationId: string;
    projects: ReadonlyArray<{ _id: string; name: string; organizationId: string; target?: null | string }>;
}): OrganizationHostnames => {
    const projects = input.projects.filter((project) => project.organizationId === input.organizationId);
    const onEdge = new Set(projects.filter((project) => (project.target ?? "cloudflare-wfp") === "cloudflare-wfp").map((project) => project._id));
    const candidates: EdgeTarget[] = [
        ...input.deployments
            .filter((row) => row.organizationId === input.organizationId && row.status === "live" && onEdge.has(row.projectId))
            .map((row) => {
                return {
                    hostname: `${row.alias ?? row.scriptName}.${input.appDomain}`.toLowerCase(),
                    projectId: row.projectId,
                    rowId: row._id,
                    source: "deployment" as const,
                };
            }),
        ...input.domains
            .filter((row) => row.organizationId === input.organizationId && row.verifiedAt != null && row.redirectTo == null && onEdge.has(row.projectId))
            .map((row) => {
                return { hostname: row.hostname.toLowerCase(), projectId: row.projectId, rowId: row._id, source: "domain" as const };
            }),
    ];
    const targets = candidates
        .filter((target) => isEdgeHostname(target.hostname))
        .toSorted((a, b) => a.hostname.localeCompare(b.hostname) || a.rowId.localeCompare(b.rowId));

    return {
        hostnames: edgeHostnames(targets.map((target) => target.hostname)),
        targets,
        unsupported: projects
            .filter((project) => !onEdge.has(project._id))
            .map((project) => {
                const target = project.target ?? "cloudflare-wfp";

                return { name: project.name, reason: UNSUPPORTED_REASON[target] ?? "not served from the platform edge", target };
            }),
    };
};
