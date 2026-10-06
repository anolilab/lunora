import { describe, expect, it, vi } from "vitest";

import { releaseEdgeRules, setAnomalyRateLimit, setDdosSensitivity } from "../lunora/edge";
import { edgeBudget, edgeHostnames, organizationHostnames } from "../src/edge/protection";
import type { EdgeRuleRow } from "../src/edge/rules";
import { engageAnomalyRateLimits, runEdgeRuleSweep } from "../src/edge/rules";
import type { ControlPlaneDatabase } from "../src/store";
import { celldVpsFleet } from "../src/targets/celld-vps/driver";
import { cloudflareWfpFleetFromEnv } from "../src/targets/cloudflare-wfp/driver";
import {
    applyEdgeRule,
    buildEdgeRule,
    createEdgeProtection,
    edgeRuleRef,
    hostExpression,
    HTTP_DDOS_MANAGED_RULESET_ID,
    readFirewallEvents,
} from "../src/targets/cloudflare-wfp/edge";
import { cloudflareWorkersFleetFromEnv } from "../src/targets/cloudflare-workers/driver";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { makeCtx, owner } from "./_helpers/fake-ctx";

const ZONE = "zone123";
const API = "https://api.cloudflare.com/client/v4";

interface Call {
    body?: unknown;
    method: string;
    url: string;
}

/**
 * A zone's rulesets in memory, behind the v4 rulesets endpoints the module
 * calls. Each phase holds at most one entrypoint; rules carry ids and refs.
 * `failOn` makes one method answer 500, to pin the failure path.
 */
const memoryZone = (seed: Record<string, { ref: string }[]> = {}, failOn?: string) => {
    let next = 0;
    const withId = (rule: { ref: string }): { id: string; ref: string } => {
        next += 1;

        return { ...rule, id: `rule_${String(next)}` };
    };
    const phases = new Map<string, { id: string; rules: { id: string; ref: string }[] }>(
        Object.entries(seed).map(([phase, rules]) => [phase, { id: `rs_${phase}`, rules: rules.map((rule) => withId(rule)) }]),
    );
    const calls: Call[] = [];
    const ok = (result: unknown) => Response.json({ errors: [], result, success: true });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;

        calls.push({ ...(body === undefined ? {} : { body }), method, url });

        if (method === failOn) {
            return Response.json({ errors: [{ message: "upstream exploded" }], success: false }, { status: 500 });
        }

        const entry = /\/zones\/zone123\/rulesets\/phases\/(\w+)\/entrypoint$/.exec(url);

        if (entry) {
            const phase = entry[1] ?? "";

            if (method === "GET") {
                const found = phases.get(phase);

                return found ? ok(found) : Response.json({ errors: [{ message: "not found" }], success: false }, { status: 404 });
            }

            const created = { id: `rs_${phase}`, rules: (body as { rules: { ref: string }[] }).rules.map((rule) => withId(rule)) };

            phases.set(phase, created);

            return ok(created);
        }

        const ruleMatch = /\/rulesets\/(rs_\w+)\/rules(?:\/(rule_\d+))?$/.exec(url);
        const ruleset = [...phases.values()].find((candidate) => candidate.id === ruleMatch?.[1]);

        if (!ruleset) {
            return Response.json({ success: false }, { status: 404 });
        }

        switch (method) {
            case "DELETE": {
                ruleset.rules = ruleset.rules.filter((rule) => rule.id !== ruleMatch?.[2]);
                break;
            }
            case "PATCH": {
                ruleset.rules = ruleset.rules.map((rule) => (rule.id === ruleMatch?.[2] ? { ...(body as { ref: string }), id: rule.id } : rule));
                break;
            }
            case "POST": {
                ruleset.rules.push(withId(body as { ref: string }));
                break;
            }
            default:
        }

        return ok(ruleset);
    });

    return { calls, fetch, phases };
};

describe("hostnames that reach an expression", () => {
    it("keeps only DNS hostnames, lowercased, de-duplicated and sorted", () => {
        expect(edgeHostnames(["B.lunora.app", "a.lunora.app", "a.lunora.app", "*.x.com", 'a" or true or "', "localhost", "x..y.com"])).toStrictEqual([
            "a.lunora.app",
            "b.lunora.app",
        ]);
    });

    it("refuses to build an expression around anything but a hostname", () => {
        expect(hostExpression(["a.lunora.app", "b.example.com"])).toBe('(http.host in {"a.lunora.app" "b.example.com"})');
        expect(() => hostExpression(['a.lunora.app" or http.host ne "x'])).toThrow("only valid hostnames");
        expect(() => hostExpression([])).toThrow("at least one hostname");
    });

    it("parses the operator budget fail-closed", () => {
        expect([
            edgeBudget(undefined),
            edgeBudget(""),
            edgeBudget("-1"),
            edgeBudget("2.5"),
            edgeBudget("abc"),
            edgeBudget("5"),
            edgeBudget("500"),
        ]).toStrictEqual([0, 0, 0, 0, 0, 5, 100]);
    });
});

describe(organizationHostnames, () => {
    const input = {
        appDomain: "lunora.app",
        deployments: [
            { _id: "d_shop", alias: "shop", organizationId: "org1", projectId: "p_wfp", scriptName: "shop", status: "live" },
            { _id: "d_old", alias: "old", organizationId: "org1", projectId: "p_wfp", scriptName: "old", status: "superseded" },
            { _id: "d_box", alias: "box-app", organizationId: "org1", projectId: "p_box", scriptName: "box-app", status: "live" },
            { _id: "d_theirs", alias: "theirs", organizationId: "org2", projectId: "p_other", scriptName: "theirs", status: "live" },
        ],
        domains: [
            { _id: "m_shop", hostname: "shop.example.com", organizationId: "org1", projectId: "p_wfp", verifiedAt: 1 },
            { _id: "m_pending", hostname: "pending.example.com", organizationId: "org1", projectId: "p_wfp" },
            { _id: "m_apex", hostname: "apex.example.com", organizationId: "org1", projectId: "p_wfp", redirectTo: "https://shop.example.com", verifiedAt: 1 },
            { _id: "m_theirs", hostname: "theirs.example.com", organizationId: "org2", projectId: "p_wfp", verifiedAt: 1 },
        ],
        organizationId: "org1",
        projects: [
            { _id: "p_wfp", name: "Shop", organizationId: "org1" },
            { _id: "p_box", name: "Box app", organizationId: "org1", target: "celld-vps" },
            { _id: "p_byo", name: "BYO", organizationId: "org1", target: "cloudflare-workers" },
            { _id: "p_other", name: "Theirs", organizationId: "org2" },
        ],
    };

    it("names only the org's live platform hostnames and verified routing domains", () => {
        expect(organizationHostnames(input).hostnames).toStrictEqual(["shop.example.com", "shop.lunora.app"]);
    });

    it("names the projects the platform zone does not serve, rather than leaving them out", () => {
        expect(organizationHostnames(input).unsupported).toStrictEqual([
            expect.objectContaining({ name: "Box app", target: "celld-vps" }),
            expect.objectContaining({ name: "BYO", target: "cloudflare-workers" }),
        ]);
    });
});

describe(applyEdgeRule, () => {
    const rule = buildEdgeRule("org1", { kind: "ddos_l7", sensitivity: "low" }, ["a.lunora.app"]);
    const ref = edgeRuleRef("ddos_l7", "org1");

    it("builds the DDoS override against the HTTP DDoS managed ruleset", () => {
        expect(rule).toStrictEqual({
            action: "execute",
            action_parameters: { id: HTTP_DDOS_MANAGED_RULESET_ID, overrides: { sensitivity_level: "low" } },
            description: "Lunora Cloud: ddos_l7 for organization org1",
            enabled: true,
            expression: '(http.host in {"a.lunora.app"})',
            ref: "lunora_ddos_l7_org1",
        });
    });

    it("creates the entrypoint only when the zone has none", async () => {
        const zone = memoryZone();

        await expect(applyEdgeRule({ apiToken: "t", fetch: zone.fetch }, { phase: "ddos_l7", ref, rule, zoneId: ZONE })).resolves.toStrictEqual({
            ruleId: "rule_1",
        });
        expect(zone.calls.map((call) => `${call.method} ${call.url}`)).toStrictEqual([
            `GET ${API}/zones/${ZONE}/rulesets/phases/ddos_l7/entrypoint`,
            `PUT ${API}/zones/${ZONE}/rulesets/phases/ddos_l7/entrypoint`,
        ]);
        expect(zone.calls[1]?.body).toStrictEqual({ rules: [rule] });
    });

    it("adds to an existing entrypoint without touching its other rules", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: "someone_else" }] });

        await applyEdgeRule({ apiToken: "t", fetch: zone.fetch }, { phase: "ddos_l7", ref, rule, zoneId: ZONE });

        expect(zone.calls.at(-1)).toMatchObject({ method: "POST", url: `${API}/zones/${ZONE}/rulesets/rs_ddos_l7/rules` });
        expect(zone.phases.get("ddos_l7")?.rules.map((candidate) => candidate.ref)).toStrictEqual(["someone_else", ref]);
    });

    it("is idempotent: a retry updates the rule under its ref rather than adding a second", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref }] });

        await applyEdgeRule({ apiToken: "t", fetch: zone.fetch }, { phase: "ddos_l7", ref, rule, zoneId: ZONE });
        await applyEdgeRule({ apiToken: "t", fetch: zone.fetch }, { phase: "ddos_l7", ref, rule, zoneId: ZONE });

        expect(zone.calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
        expect(zone.phases.get("ddos_l7")?.rules).toHaveLength(1);
    });

    it("removes only its own rule, and a removal of nothing writes nothing", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: "someone_else" }, { ref }] });

        await applyEdgeRule({ apiToken: "t", fetch: zone.fetch }, { phase: "ddos_l7", ref, rule: null, zoneId: ZONE });
        await applyEdgeRule({ apiToken: "t", fetch: zone.fetch }, { phase: "ddos_l7", ref, rule: null, zoneId: ZONE });

        expect(zone.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
        expect(zone.phases.get("ddos_l7")?.rules.map((candidate) => candidate.ref)).toStrictEqual(["someone_else"]);
    });

    it("throws when Cloudflare refuses the write, with no token in the message", async () => {
        const zone = memoryZone({ ddos_l7: [] }, "POST");

        await expect(applyEdgeRule({ apiToken: "secret-token", fetch: zone.fetch }, { phase: "ddos_l7", ref, rule, zoneId: ZONE })).rejects.toThrow(
            /^(?!.*secret-token).*upstream exploded/,
        );
    });
});

describe(readFirewallEvents, () => {
    const answer = (rows: Record<string, unknown>[]) => Response.json({ data: { viewer: { zones: [{ firewallEventsAdaptive: rows }] } }, errors: null });

    it("queries the zone for the org's hostnames over at most a day, and drops rows outside them", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
            answer([
                {
                    action: "block",
                    clientCountryName: "DE",
                    // Cloudflare can return the client address; it must never reach the view.
                    clientIP: "192.0.2.1", // NOSONAR -- RFC 5737 documentation address
                    clientRequestHTTPHost: "a.lunora.app",
                    clientRequestPath: "/x",
                    datetime: "t",
                    source: "waf",
                },
                { action: "block", clientRequestHTTPHost: "other-tenant.lunora.app", clientRequestPath: "/", datetime: "t", source: "waf" },
            ]),
        );
        const to = Date.now();
        const result = await readFirewallEvents({ apiToken: "t", fetch }, { from: 0, hostnames: ["a.lunora.app", "bad host"], to, zoneId: ZONE });

        expect(result).toStrictEqual({
            events: [{ action: "block", country: "DE", datetime: "t", host: "a.lunora.app", path: "/x", source: "waf" }],
            status: "ok",
        });

        const body = fetch.mock.calls[0]?.[1]?.body;
        const sent = JSON.parse(typeof body === "string" ? body : "{}") as { query: string; variables: Record<string, unknown> };

        expect(sent.variables).toMatchObject({ hosts: ["a.lunora.app"], limit: 100, zoneTag: ZONE });
        expect(Date.parse(String(sent.variables.until)) - Date.parse(String(sent.variables.since))).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
        expect(sent.query).not.toContain("clientIP");
    });

    it("degrades to unavailable with Cloudflare's reason when the plan or token does not allow the read", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: null, errors: [{ message: "zone does not have access to the path" }] }));

        await expect(
            readFirewallEvents({ apiToken: "t", fetch }, { from: 0, hostnames: ["a.lunora.app"], to: Date.now(), zoneId: ZONE }),
        ).resolves.toMatchObject({ events: [], reason: expect.stringContaining("does not have access"), status: "unavailable" });
    });

    it("never calls Cloudflare for an org with no hostnames", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();

        await expect(readFirewallEvents({ apiToken: "t", fetch }, { from: 0, hostnames: [], to: 1, zoneId: ZONE })).resolves.toStrictEqual({
            events: [],
            status: "ok",
        });
        expect(fetch).not.toHaveBeenCalled();
    });
});

const NOW = 1_700_000_000_000;

const edgeRow = (overrides: Partial<EdgeRuleRow> = {}): EdgeRuleRow => {
    return {
        _id: "edge1",
        applied: false,
        attempts: 0,
        targets: [],
        kind: "ddos_l7",
        organizationId: "org1",
        sensitivity: "low",
        status: "pending",
        updatedAt: NOW - 1000,
        ...overrides,
    };
};

/** The target the default org's one live deployment gives it. */
const SHOP = { hostname: "shop.lunora.app", projectId: "p1", rowId: "dep1", source: "deployment" as const };

/** The control-plane store with a table-pinned `get`, as the real ctx-db has. */
const store = (tables: Record<string, unknown[]>, spies: Partial<ControlPlaneDatabase> = {}) => {
    return {
        ...fakeControlPlaneDb(tables, spies),
        get: (id: string, table?: string) => Promise.resolve((tables[table ?? ""] ?? []).find((row) => (row as { _id: string })._id === id) ?? null),
    };
};

const orgTables = (row: EdgeRuleRow, organization?: Record<string, unknown>) => {
    return {
        deployments: [{ _id: "dep1", alias: "shop", organizationId: "org1", projectId: "p1", scriptName: "shop", status: "live" }],
        domains: [],
        edgeRules: [row],
        organizations: [organization ?? { _id: "org1" }],
        projects: [{ _id: "p1", name: "Shop", organizationId: "org1" }],
    };
};

const options = (fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) => {
    return {
        appDomain: "lunora.app",
        budgets: { ddos_l7: 10, rate_limit: 5 },
        edge: createEdgeProtection({ credentials: { apiToken: "t", fetch }, zoneId: ZONE }),
        recheckUnavailable: false,
        now: NOW,
        ...overrides,
    };
};

describe(runEdgeRuleSweep, () => {
    it("applies a pending override and records the rule and an audit entry", async () => {
        const zone = memoryZone();
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));

        await expect(runEdgeRuleSweep(store(orgTables(edgeRow()), { insert, patch }), options(zone.fetch))).resolves.toStrictEqual({ applied: 1 });
        expect(patch).toHaveBeenCalledWith(
            "edge1",
            expect.objectContaining({ applied: true, cloudflareRuleId: "rule_1", targets: [SHOP], status: "applied" }),
            "edgeRules",
        );
        expect(insert).toHaveBeenCalledWith("auditLog", expect.objectContaining({ action: "edge.ddos_l7.applied", organizationId: "org1" }));
        expect(zone.phases.get("ddos_l7")?.rules).toHaveLength(1);
    });

    it("records a failed write and leaves `applied` as it was", async () => {
        const zone = memoryZone({}, "PUT");
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));

        await runEdgeRuleSweep(store(orgTables(edgeRow()), { insert, patch }), options(zone.fetch));

        expect(patch).toHaveBeenCalledWith("edge1", expect.not.objectContaining({ applied: expect.anything() }), "edgeRules");
        expect(patch).toHaveBeenCalledWith(
            "edge1",
            expect.objectContaining({ attempts: 1, lastError: expect.stringContaining("upstream exploded"), status: "failed" }),
            "edgeRules",
        );
        expect(insert).toHaveBeenCalledWith("auditLog", expect.objectContaining({ action: "edge.ddos_l7.failed" }));
    });

    it("finishes a write that landed before a crash, by ref, without a duplicate", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: edgeRuleRef("ddos_l7", "org1") }] });

        await runEdgeRuleSweep(store(orgTables(edgeRow())), options(zone.fetch));

        expect(zone.phases.get("ddos_l7")?.rules).toHaveLength(1);
        expect(zone.calls.some((call) => call.method === "PATCH")).toBe(true);
    });

    it("fails closed without a budget: nothing is written to Cloudflare", async () => {
        const zone = memoryZone();
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await runEdgeRuleSweep(store(orgTables(edgeRow()), { patch }), options(zone.fetch, { budgets: { ddos_l7: 0, rate_limit: 0 } }));

        expect(zone.calls).toStrictEqual([]);
        expect(patch).toHaveBeenCalledWith(
            "edge1",
            expect.objectContaining({ lastError: "ddos_l7 rules are not enabled on this cell", status: "unavailable" }),
            "edgeRules",
        );
    });

    it("refuses a rule past the budget other orgs already use", async () => {
        const zone = memoryZone();
        const tables = orgTables(edgeRow());

        tables.edgeRules.push(edgeRow({ _id: "edge_other", applied: true, organizationId: "org2", status: "applied" }));
        tables.organizations.push({ _id: "org2" });
        await runEdgeRuleSweep(store(tables), options(zone.fetch, { budgets: { ddos_l7: 1, rate_limit: 0 } }));

        // org2's applied rule is re-checked (it has no hostnames left, so it would come
        // off), but nothing is ever written for org1.
        expect(zone.calls.filter((call) => call.method !== "GET" && call.method !== "DELETE")).toStrictEqual([]);
    });

    it("records why without a zone, and keeps an applied rule recorded rather than forgotten", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await runEdgeRuleSweep(store(orgTables(edgeRow({ applied: true, sensitivity: "default" })), { patch }), options(globalThis.fetch, { edge: undefined }));

        expect(patch).toHaveBeenCalledWith("edge1", expect.objectContaining({ status: "unavailable" }), "edgeRules");
        expect(patch).not.toHaveBeenCalledWith("edge1", expect.objectContaining({ applied: false }), "edgeRules");
    });

    it("takes a deleting organization's rule off the zone", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: edgeRuleRef("ddos_l7", "org1") }] });

        await runEdgeRuleSweep(store(orgTables(edgeRow({ applied: true }), { _id: "org1", deletionRequestedAt: 1 })), options(zone.fetch));

        expect(zone.phases.get("ddos_l7")?.rules).toStrictEqual([]);
    });

    it("applies an armed, engaged rate limit on the org's hostnames", async () => {
        const zone = memoryZone();
        const row = edgeRow({ armed: true, engaged: true, kind: "rate_limit", periodSeconds: 60, requestsPerPeriod: 500, sensitivity: undefined });

        await runEdgeRuleSweep(store(orgTables(row)), options(zone.fetch));

        expect(zone.calls.at(-1)).toMatchObject({
            body: {
                rules: [
                    expect.objectContaining({
                        action: "block",
                        expression: '(http.host in {"shop.lunora.app"})',
                        ratelimit: expect.objectContaining({ period: 60, requests_per_period: 500 }),
                        ref: "lunora_rate_limit_org1",
                    }),
                ],
            },
            method: "PUT",
            url: `${API}/zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`,
        });
    });

    it("leaves an applied, unchanged rule alone on every pass", async () => {
        const zone = memoryZone();

        await expect(
            runEdgeRuleSweep(store(orgTables(edgeRow({ applied: true, targets: [SHOP], status: "applied" }))), options(zone.fetch)),
        ).resolves.toStrictEqual({ skipped: 1 });
        expect(zone.calls).toStrictEqual([]);
    });

    const appliedRow = (targets = [SHOP, { hostname: "shop.example.com", projectId: "p1", rowId: "dom1", source: "domain" as const }]) =>
        edgeRow({ applied: true, status: "applied", targets });
    const ourRef = edgeRuleRef("ddos_l7", "org1");

    it("takes a custom domain off the rule once it moved to another organization", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: ourRef }] });
        const tables = {
            ...orgTables(appliedRow()),
            // dom1 now belongs to org2: org1's rule must stop covering its hostname.
            domains: [{ _id: "dom1", hostname: "shop.example.com", organizationId: "org2", projectId: "p9", verifiedAt: 1 }],
        };
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await runEdgeRuleSweep(store(tables, { patch }), options(zone.fetch));

        expect(zone.calls.find((call) => call.method === "PATCH")?.body).toMatchObject({ expression: '(http.host in {"shop.lunora.app"})', ref: ourRef });
        expect(patch).toHaveBeenCalledWith("edge1", expect.objectContaining({ targets: [SHOP] }), "edgeRules");
    });

    it("treats a deleted-then-re-added hostname as a different row, and re-binds only to the org's own", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: ourRef }] });
        // dom1 was deleted; the same hostname now exists as dom2 — under org2.
        const tables = {
            ...orgTables(appliedRow()),
            domains: [{ _id: "dom2", hostname: "shop.example.com", organizationId: "org2", projectId: "p9", verifiedAt: 1 }],
        };
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await runEdgeRuleSweep(store(tables, { patch }), options(zone.fetch));

        expect(patch).toHaveBeenCalledWith("edge1", expect.objectContaining({ targets: [SHOP] }), "edgeRules");
    });

    it("re-applies when the same hostname comes back as a new row of the same org", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: ourRef }] });
        const tables = {
            ...orgTables(appliedRow()),
            domains: [{ _id: "dom2", hostname: "shop.example.com", organizationId: "org1", projectId: "p1", verifiedAt: 1 }],
        };
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await runEdgeRuleSweep(store(tables, { patch }), options(zone.fetch));

        expect(patch).toHaveBeenCalledWith("edge1", expect.objectContaining({ targets: [expect.objectContaining({ rowId: "dom2" }), SHOP] }), "edgeRules");
    });

    it("never writes to a stale Cloudflare id on the row: the rule is found by ref on a fresh read", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: "someone_elses_rule" }, { ref: ourRef }] });
        // rule_1 is the other rule; the row remembers it from some earlier state.
        const row = { ...edgeRow({ sensitivity: "medium" }), cloudflareRuleId: "rule_1" };

        await runEdgeRuleSweep(store(orgTables(row)), options(zone.fetch));

        expect(zone.calls.filter((call) => call.method === "PATCH").map((call) => call.url)).toStrictEqual([
            `${API}/zones/${ZONE}/rulesets/rs_ddos_l7/rules/rule_2`,
        ]);
        expect(zone.phases.get("ddos_l7")?.rules[0]).toStrictEqual({ id: "rule_1", ref: "someone_elses_rule" });
    });

    it("refuses to write when the zone holds two rules under the org's ref", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: ourRef }, { ref: ourRef }] });
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await runEdgeRuleSweep(store(orgTables(edgeRow()), { patch }), options(zone.fetch));

        expect(zone.calls.map((call) => call.method)).toStrictEqual(["GET"]);
        expect(patch).toHaveBeenCalledWith(
            "edge1",
            expect.objectContaining({ lastError: expect.stringContaining("more than one rule"), status: "failed" }),
            "edgeRules",
        );
    });

    it("refuses an organization id that cannot name a rule unambiguously", () => {
        expect(() => edgeRuleRef("ddos_l7", "org-1")).toThrow("unambiguously");
    });

    it("skips the write when the row changed since the pass read it", async () => {
        const zone = memoryZone();
        const row = edgeRow();
        const database = store(orgTables(row));
        const reread = { ...row, updatedAt: row.updatedAt + 1 };

        await runEdgeRuleSweep(
            { ...database, get: (id, table) => (table === "edgeRules" ? Promise.resolve(reread) : database.get(id, table)) },
            options(zone.fetch),
        );

        expect(zone.calls).toStrictEqual([]);
    });

    it("removes an erased organization's rule, retrying past the attempt cap, then deletes its row", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: ourRef }] });
        const remove = vi.fn<ControlPlaneDatabase["delete"]>(() => Promise.resolve(undefined));
        // The org row is gone (purged); the row is applied and has failed many times.
        const tables = { ...orgTables(edgeRow({ applied: true, attempts: 50, status: "failed", targets: [SHOP], updatedAt: 0 })), organizations: [] };

        await runEdgeRuleSweep(store(tables, { delete: remove }), options(zone.fetch));

        expect(zone.phases.get("ddos_l7")?.rules).toStrictEqual([]);
        expect(remove).toHaveBeenCalledWith("edge1", "edgeRules");
    });

    it("takes an applied rule off when its organization now has too many hostnames", async () => {
        const zone = memoryZone({ ddos_l7: [{ ref: ourRef }] });
        const tables = {
            ...orgTables(appliedRow([SHOP])),
            domains: Array.from({ length: 51 }, (_, index) => {
                return { _id: `d${String(index)}`, hostname: `h${String(index)}.example.com`, organizationId: "org1", projectId: "p1", verifiedAt: 1 };
            }),
        };

        await runEdgeRuleSweep(store(tables), options(zone.fetch));

        expect(zone.phases.get("ddos_l7")?.rules).toStrictEqual([]);
    });
});

describe(engageAnomalyRateLimits, () => {
    const transition = {
        action: "fire" as const,
        organizationId: "org1",
        reading: { mean: 1, score: 9, value: 9 },
        ruleId: "r1",
        target: "usage_anomaly" as const,
    };
    const tables = (row: EdgeRuleRow) => {
        return {
            alertRuleState: [{ firing: true, organizationId: "org1", ruleId: "r1" }],
            alertRules: [{ _id: "r1", enabled: true, organizationId: "org1", target: "usage_anomaly" }],
            edgeRules: [row],
        };
    };

    it("records an armed org's rate limit as wanted while its usage anomaly fires", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));

        await expect(engageAnomalyRateLimits(store(tables(edgeRow({ armed: true, kind: "rate_limit" })), { insert, patch }), [transition], NOW)).resolves.toBe(
            1,
        );
        expect(patch).toHaveBeenCalledWith("edge1", expect.objectContaining({ engaged: true, status: "pending" }), "edgeRules");
        expect(insert).toHaveBeenCalledWith(
            "auditLog",
            expect.objectContaining({ action: "edge.rate_limit.engage", actorUserId: "system:anomaly", organizationId: "org1" }),
        );
    });

    it("does nothing for an org that did not arm the action", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));

        await expect(engageAnomalyRateLimits(store(tables(edgeRow({ armed: false, kind: "rate_limit" })), { patch }), [transition], NOW)).resolves.toBe(0);
        expect(patch).not.toHaveBeenCalled();
    });
});

describe(releaseEdgeRules, () => {
    it("deletes an erased organization's rows whose rule is off the zone, and keeps the applied ones for the reconciler", async () => {
        const { ctx, ops } = makeCtx({
            edgeRules: [
                { _id: "e_off", applied: false, kind: "rate_limit", organizationId: "org1" },
                { _id: "e_on", applied: true, kind: "ddos_l7", organizationId: "org1" },
                { _id: "e_other", applied: false, kind: "ddos_l7", organizationId: "org2" },
            ],
        });

        await releaseEdgeRules(ctx, "org1" as never);

        expect(ops).toStrictEqual([{ id: "e_off", kind: "delete" }]);
    });
});

describe("edge settings", () => {
    it("stamps the org from the verified membership and audits the change", async () => {
        const { ctx, ops } = makeCtx({ edgeRules: [], members: [owner("org1")] });

        await setDdosSensitivity.handler(ctx, { organizationId: "org1", sensitivity: "low" } as never);

        expect(ops.find((op) => op.kind === "insert" && op.table === "edgeRules")).toMatchObject({
            document: { applied: false, kind: "ddos_l7", organizationId: "org1", sensitivity: "low", status: "pending" },
        });
        expect(ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({
            document: { action: "edge.ddos_l7.configure", actorUserId: "usr_1", organizationId: "org1" },
        });
    });

    it("updates the org's own row, never another org's", async () => {
        const { ctx, ops } = makeCtx({
            edgeRules: [
                { _id: "e_org2", kind: "ddos_l7", organizationId: "org2" },
                { _id: "e_org1", kind: "ddos_l7", organizationId: "org1" },
            ],
            members: [owner("org1")],
        });

        await setDdosSensitivity.handler(ctx, { organizationId: "org1", sensitivity: "medium" } as never);

        expect(ops.filter((op) => op.kind === "patch").map((op) => op.id)).toStrictEqual(["e_org1"]);
    });

    it("refuses a member who is not an owner or admin", async () => {
        const { ctx } = makeCtx({ edgeRules: [], members: [{ ...owner("org1"), role: "member" }] });

        await expect(setAnomalyRateLimit.handler(ctx, { enabled: true, organizationId: "org1", requestsPerPeriod: 100 } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it.each([undefined, 5, 1.5, 2_000_000])("refuses a rate limit of %s requests", async (requestsPerPeriod) => {
        const { ctx } = makeCtx({ edgeRules: [], members: [owner("org1")] });

        await expect(setAnomalyRateLimit.handler(ctx, { enabled: true, organizationId: "org1", requestsPerPeriod } as never)).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
    });
});

describe("which fleets front tenants with the platform edge", () => {
    it("offers edge protection on cloudflare-wfp only with the SaaS zone and a token", () => {
        expect(cloudflareWfpFleetFromEnv({ CLOUDFLARE_API_TOKEN: "t", LUNORA_SAAS_ZONE_ID: ZONE }).edge).toBeDefined();
        expect(cloudflareWfpFleetFromEnv({ CLOUDFLARE_API_TOKEN: "t" }).edge).toBeUndefined();
        expect(cloudflareWfpFleetFromEnv({ LUNORA_SAAS_ZONE_ID: ZONE }).edge).toBeUndefined();
    });

    it("offers none on a box or a customer's own account", () => {
        expect(celldVpsFleet.edge).toBeUndefined();
        expect(cloudflareWorkersFleetFromEnv({}).edge).toBeUndefined();
    });
});
