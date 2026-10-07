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

/** The shape an organization id must have to name a rule: injective into a ref, so two orgs can never share one. */
const REF_SAFE_ID = /^[a-z0-9]{1,64}$/i;

/**
 * The rule's stable ref, and the ONLY way a write finds its rule: never a name,
 * a description, an expression or an id remembered from an earlier call. An id
 * that would need rewriting to fit is refused rather than sanitized, because a
 * sanitized ref could collide with another organization's.
 */
export const edgeRuleRef = (kind: EdgeRuleKind, organizationId: string): string => {
    if (!REF_SAFE_ID.test(organizationId)) {
        throw new Error("this organization id cannot name an edge rule unambiguously");
    }

    return `lunora_${kind}_${organizationId}`;
};

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

/** A ruleset as validated from an answer: an id, and every rule with a string id. */
interface Ruleset {
    id: string;
    rules: { expression?: unknown; id: string; ref?: unknown }[];
}

/** The longest one Cloudflare call may take; past it the call aborts and the row records a failure. */
export const EDGE_CALL_TIMEOUT_MS = 10_000;

/** `fetch` bounded by {@link EDGE_CALL_TIMEOUT_MS}, so a hung call fails instead of stalling the sweep. */
export const boundedFetch =
    (base: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch =>
    async (input, init) =>
        base(input, { ...init, signal: AbortSignal.timeout(EDGE_CALL_TIMEOUT_MS) });

/**
 * Validate a ruleset answer, or throw. A 2xx whose body is missing, partial or
 * the wrong shape is NOT "no rules": read that way, a removal would report
 * success with the rule still on the zone, and an apply would create a duplicate
 * or replace the whole entrypoint.
 */
const rulesetOf = (value: unknown): Ruleset => {
    const candidate = value as null | { id?: unknown; rules?: unknown } | undefined;
    const rules = candidate?.rules ?? [];

    if (typeof candidate?.id !== "string" || candidate.id === "" || !Array.isArray(rules)) {
        throw new Error("Cloudflare answered the ruleset without an id or a rule list; refusing to act on it");
    }

    for (const rule of rules as unknown[]) {
        if (typeof rule !== "object" || rule === null || typeof (rule as { id?: unknown }).id !== "string") {
            throw new Error("Cloudflare answered a ruleset rule without an id; refusing to act on it");
        }
    }

    return { id: candidate.id, rules: rules as Ruleset["rules"] };
};

/** The rules under `ref` — more than one is a zone this code did not write, so refuse (fail closed). */
const rulesUnder = (ruleset: Ruleset, ref: string): Ruleset["rules"] => {
    const matches = ruleset.rules.filter((candidate) => candidate.ref === ref);

    if (matches.length > 1) {
        throw new Error("the zone holds more than one rule under this organization's ref; refusing to write");
    }

    return matches;
};

/**
 * Confirm a write: the answer holds exactly one rule under `ref`, carrying the
 * expression just sent. Anything else — no rule, a partial answer, a different
 * expression — did not verifiably apply, so the caller records a failure.
 */
const confirmWritten = (value: unknown, rule: RulesetRule): { ruleId: string } => {
    const [written] = rulesUnder(rulesetOf(value), rule.ref);

    if (written?.expression !== rule.expression) {
        throw new Error("Cloudflare accepted the ruleset write but does not hold the rule as written");
    }

    return { ruleId: written.id };
};

/**
 * Make the zone's `phase` entrypoint hold exactly `rule` under `ref`, or no rule
 * under `ref` when `rule` is `null`. Every call reads the entrypoint fresh and
 * finds the rule by ref, so nothing from an earlier call or a row is addressed.
 *
 * Fails closed throughout: a Cloudflare error, a timeout, or a malformed or
 * partial answer throws rather than being read as "no rule". The entrypoint is
 * created (a PUT, which REPLACES a phase's rules) only on an explicit 404 for it
 * on a zone confirmed to exist. A removal is confirmed by a fresh read.
 */
export const applyEdgeRule = async (
    credentials: CloudflareCredentials,
    input: { phase: string; ref: string; rule: null | RulesetRule; zoneId: string },
): Promise<{ ruleId?: string }> => {
    const call = cloudflareFetch({ ...credentials, fetch: boundedFetch(credentials.fetch) });
    const zonePath = `/zones/${encodeURIComponent(input.zoneId)}`;
    const zone = `${zonePath}/rulesets`;
    const entrypointPath = `${zone}/phases/${encodeURIComponent(input.phase)}/entrypoint`;
    const readEntrypoint = async (): Promise<null | Ruleset> => {
        const answer = await call<unknown>(entrypointPath, { allow404: true });

        if (answer !== null) {
            return rulesetOf(answer.result);
        }

        // A 404 means "no entrypoint" only on a zone that exists. A wrong or deleted
        // zone 404s too, and read as "no rule" it would report a removal that never
        // happened. The zone read throws unless the zone is there.
        await call(zonePath);

        return null;
    };

    const ruleset = await readEntrypoint();
    const existing: Ruleset["rules"][number] | undefined = ruleset === null ? undefined : rulesUnder(ruleset, input.ref)[0];

    if (input.rule === null) {
        if (ruleset === null || existing === undefined) {
            return {};
        }

        await call(`${zone}/${encodeURIComponent(ruleset.id)}/rules/${encodeURIComponent(existing.id)}`, { allow404: true, method: "DELETE" });

        const after = await readEntrypoint();

        if (after !== null && rulesUnder(after, input.ref).length > 0) {
            throw new Error("Cloudflare still holds the rule after deleting it");
        }

        return {};
    }

    if (ruleset === null) {
        const created = await call<unknown>(entrypointPath, { body: { rules: [input.rule] }, method: "PUT" });

        return confirmWritten(created?.result, input.rule);
    }

    const written = existing
        ? await call<unknown>(`${zone}/${encodeURIComponent(ruleset.id)}/rules/${encodeURIComponent(existing.id)}`, { body: input.rule, method: "PATCH" })
        : await call<unknown>(`${zone}/${encodeURIComponent(ruleset.id)}/rules`, { body: input.rule, method: "POST" });

    return confirmWritten(written?.result, input.rule);
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
        const response = await boundedFetch(credentials.fetch)(`${credentials.baseUrl ?? CLOUDFLARE_API_ROOT}/graphql`, {
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
