/**
 * `cloudflare-wfp`'s edge protection (plan 365 W7, D9) on the SaaS zone — the
 * zone of `LUNORA_APP_DOMAIN` that every tenant hostname and custom domain is
 * served from. Surfaces and configures what Cloudflare already does; builds no
 * mitigation.
 *
 * - **Firewall events**: the GraphQL Analytics API's `firewallEventsAdaptive`.
 * - **Edge rules**: one rule per (organization, kind) in a zone phase
 *   entrypoint under a stable `ref`, so every write is an idempotent upsert or
 *   delete by ref. `ddos_l7` overrides the HTTP DDoS managed ruleset's
 *   sensitivity; `rate_limit` is the anomaly-triggered rate-limit rule.
 *
 * Every value in a Rules expression is a hostname re-validated against a strict
 * DNS grammar, so a row can never inject expression text. The token travels
 * only in the `authorization` header, and no error message echoes it.
 */
import type { CloudflareCredentials } from "../../cloudflare/fetch";
import { CLOUDFLARE_API_ROOT, cloudflareFetch } from "../../cloudflare/fetch";
import type { EdgeProtection, EdgeRuleConfig, EdgeRuleKind, FirewallEvent, FirewallEventsResult } from "../../edge/protection";
import { edgeHostnames, isEdgeHostname, MAX_EDGE_HOSTNAMES, MAX_FIREWALL_EVENTS, MAX_FIREWALL_WINDOW_MS } from "../../edge/protection";

/** The zone phase each kind lives in. */
export const EDGE_PHASE: Record<EdgeRuleKind, string> = { ddos_l7: "ddos_l7", rate_limit: "http_ratelimit" };

/** Cloudflare's HTTP DDoS Attack Protection managed ruleset. */
export const HTTP_DDOS_MANAGED_RULESET_ID = "4d21379b4f9f4bb088e0729962c8b3cf";

/** The rule's stable ref: the idempotency key for every write. Organization ids are opaque; only `[A-Za-z0-9]` survives. */
export const edgeRuleRef = (kind: EdgeRuleKind, organizationId: string): string => `lunora_${kind}_${organizationId.replaceAll(/[^a-z0-9]/gi, "")}`;

/** `(http.host in {"a" "b"})` — every hostname re-validated, so nothing but DNS text is quoted. */
export const hostExpression = (hostnames: ReadonlyArray<string>): string => {
    const valid = hostnames.filter((hostname) => isEdgeHostname(hostname));

    if (valid.length === 0 || valid.length !== hostnames.length) {
        throw new Error("an edge rule needs at least one hostname, and only valid hostnames");
    }

    return `(http.host in {${valid.map((hostname) => `"${hostname}"`).join(" ")}})`;
};

/** A rule as the rulesets API takes it. */
export interface RulesetRule {
    action: string;
    action_parameters?: Record<string, unknown>;
    description: string;
    enabled: boolean;
    expression: string;
    ratelimit?: Record<string, unknown>;
    ref: string;
}

/** Build the Cloudflare rule for one organization's config over its hostnames. */
export const buildEdgeRule = (organizationId: string, config: EdgeRuleConfig, hostnames: ReadonlyArray<string>): RulesetRule => {
    const base = {
        description: `Lunora Cloud: ${config.kind} for organization ${organizationId}`,
        enabled: true,
        expression: hostExpression(hostnames),
        ref: edgeRuleRef(config.kind, organizationId),
    };

    if (config.kind === "ddos_l7") {
        return {
            ...base,
            action: "execute",
            action_parameters: { id: HTTP_DDOS_MANAGED_RULESET_ID, overrides: { sensitivity_level: config.sensitivity } },
        };
    }

    return {
        ...base,
        action: "block",
        ratelimit: {
            characteristics: ["cf.colo.id", "ip.src"],
            mitigation_timeout: config.periodSeconds,
            period: config.periodSeconds,
            requests_per_period: config.requestsPerPeriod,
        },
    };
};

interface Ruleset {
    id?: string;
    rules?: { id?: string; ref?: string }[];
}

/** The id Cloudflare gave the rule under `ref` — an apply that cannot name its rule did not verifiably apply. */
const ruleIdOf = (ruleset: Ruleset | undefined, ref: string): { ruleId: string } => {
    const id = ruleset?.rules?.find((candidate) => candidate.ref === ref)?.id;

    if (!id) {
        throw new Error("Cloudflare accepted the ruleset write but returned no rule under its ref");
    }

    return { ruleId: id };
};

/**
 * Make the zone's `phase` entrypoint hold exactly `rule` under `ref`, or no rule
 * under `ref` when `rule` is `null`. Found by ref, so a retry after a crash
 * updates rather than duplicates, and removing a rule already gone writes
 * nothing. An entrypoint is created only when Cloudflare reports none, so the
 * phase's other rules are never replaced.
 */
export const applyEdgeRule = async (
    credentials: CloudflareCredentials,
    input: { phase: string; ref: string; rule: null | RulesetRule; zoneId: string },
): Promise<{ ruleId?: string }> => {
    const call = cloudflareFetch(credentials);
    const zone = `/zones/${encodeURIComponent(input.zoneId)}/rulesets`;
    const entrypointPath = `${zone}/phases/${encodeURIComponent(input.phase)}/entrypoint`;
    const entrypoint = await call<Ruleset>(entrypointPath, { allow404: true });
    const ruleset = entrypoint?.result;
    const existing = ruleset?.rules?.find((candidate) => candidate.ref === input.ref);

    if (input.rule === null) {
        if (ruleset?.id && existing?.id) {
            await call(`${zone}/${encodeURIComponent(ruleset.id)}/rules/${encodeURIComponent(existing.id)}`, { allow404: true, method: "DELETE" });
        }

        return {};
    }

    if (!ruleset?.id) {
        const created = await call<Ruleset>(entrypointPath, { body: { rules: [input.rule] }, method: "PUT" });

        return ruleIdOf(created?.result, input.ref);
    }

    const written = existing?.id
        ? await call<Ruleset>(`${zone}/${encodeURIComponent(ruleset.id)}/rules/${encodeURIComponent(existing.id)}`, { body: input.rule, method: "PATCH" })
        : await call<Ruleset>(`${zone}/${encodeURIComponent(ruleset.id)}/rules`, { body: input.rule, method: "POST" });

    return ruleIdOf(written?.result, input.ref);
};

const FIREWALL_QUERY = `query FirewallEvents($zoneTag: string, $hosts: [string!], $since: Time!, $until: Time!, $limit: uint64!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      firewallEventsAdaptive(filter: { datetime_geq: $since, datetime_leq: $until, clientRequestHTTPHost_in: $hosts }, limit: $limit, orderBy: [datetime_DESC]) {
        action
        clientCountryName
        clientRequestHTTPHost
        clientRequestPath
        datetime
        source
      }
    }
  }
}`;

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/** Bound every field Cloudflare returns before it reaches a client. */
const toFirewallEvent = (row: Record<string, unknown>): FirewallEvent => {
    return {
        action: text(row.action, 32),
        country: text(row.clientCountryName, 64),
        datetime: text(row.datetime, 32),
        host: text(row.clientRequestHTTPHost, 253),
        path: text(row.clientRequestPath, 200),
        source: text(row.source, 32),
    };
};

interface GraphqlAnswer {
    data?: { viewer?: { zones?: { firewallEventsAdaptive?: Record<string, unknown>[] }[] } };
    errors?: { message?: string }[] | null;
}

/**
 * Read the zone's firewall events for `hostnames` over `[from, to]`, newest
 * first, the window clamped to {@link MAX_FIREWALL_WINDOW_MS}. A refused token,
 * a plan without the dataset, or any GraphQL error answers `unavailable` with
 * Cloudflare's own bounded message; it never throws.
 */
export const readFirewallEvents = async (
    credentials: CloudflareCredentials,
    input: { from: number; hostnames: ReadonlyArray<string>; to: number; zoneId: string },
): Promise<FirewallEventsResult> => {
    const hostnames = edgeHostnames(input.hostnames).slice(0, MAX_EDGE_HOSTNAMES);

    if (hostnames.length === 0) {
        return { events: [], status: "ok" };
    }

    const to = Math.min(input.to, Date.now());
    const from = Math.max(input.from, to - MAX_FIREWALL_WINDOW_MS);

    try {
        const response = await (credentials.fetch ?? globalThis.fetch)(`${credentials.baseUrl ?? CLOUDFLARE_API_ROOT}/graphql`, {
            body: JSON.stringify({
                query: FIREWALL_QUERY,
                variables: {
                    hosts: hostnames,
                    limit: MAX_FIREWALL_EVENTS,
                    since: new Date(from).toISOString(),
                    until: new Date(to).toISOString(),
                    zoneTag: input.zoneId,
                },
            }),
            headers: { authorization: `Bearer ${credentials.apiToken}`, "content-type": "application/json" },
            method: "POST",
        });
        const answer = (await response.json().catch(() => null)) as GraphqlAnswer | null;
        const message = answer?.errors?.map((error) => error.message ?? "").join("; ") ?? "";

        if (!response.ok || message !== "") {
            return {
                events: [],
                reason: `Cloudflare firewall analytics: ${(message === "" ? `HTTP ${String(response.status)}` : message).slice(0, 300)}`,
                status: "unavailable",
            };
        }

        const allowed = new Set(hostnames);

        // The zone is shared by every tenant. The query filters by host, and this is
        // the second fence: a dropped filter can never hand one org another's events.
        return {
            events: (answer?.data?.viewer?.zones?.[0]?.firewallEventsAdaptive ?? [])
                .map((row) => toFirewallEvent(row))
                .filter((event) => allowed.has(event.host.toLowerCase()))
                .slice(0, MAX_FIREWALL_EVENTS),
            status: "ok",
        };
    } catch {
        return { events: [], reason: "Cloudflare firewall analytics could not be reached", status: "unavailable" };
    }
};

/** The fleet's {@link EdgeProtection} on the SaaS zone. */
export const createEdgeProtection = (options: { credentials: CloudflareCredentials; zoneId: string }): EdgeProtection => {
    return {
        apply: async ({ config, hostnames, kind, organizationId }) =>
            applyEdgeRule(options.credentials, {
                phase: EDGE_PHASE[kind],
                ref: edgeRuleRef(kind, organizationId),
                rule: config !== null && hostnames.length > 0 ? buildEdgeRule(organizationId, config, hostnames) : null,
                zoneId: options.zoneId,
            }),
        firewallEvents: async (input) => readFirewallEvents(options.credentials, { ...input, zoneId: options.zoneId }),
    };
};
