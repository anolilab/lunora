import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AlertsCommandOptions } from "../../src/commands/alerts/handler";
import { runAlertsCommand } from "../../src/commands/alerts/handler";
import type { Policy } from "../../src/commands/alerts/plan";
import { planAlerts, roundUpNice, thresholdFor } from "../../src/commands/alerts/plan";
import { discoverProducts } from "../../src/commands/alerts/products";
import type { MetricUsage } from "../../src/commands/alerts/usage";
import { previousMonth } from "../../src/commands/alerts/usage";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";

const ACCOUNT = "acc123";
const REST_PREFIX = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/** The `filter_options` a discoverable account returns: an explicit product list with labels. */
const PRODUCT_OPTIONS = [
    {
        key: "product",
        values: [
            { label: "Workers Requests", value: "prod_workers_req" },
            { label: "Workers CPU Time", unit: "ms", value: "prod_workers_cpu" },
            { label: "Durable Objects Requests", value: "prod_do_req" },
        ],
    },
];

const availableAlerts = (filterOptions: unknown[]): unknown => {
    return {
        Billing: [{ display_name: "Usage Based Billing", filter_options: filterOptions, type: "billing_usage_alert" }],
        Origin: [{ type: "http_alert_origin_error" }],
    };
};

interface FakeReply {
    body: unknown;
    status: number;
}

interface FakeAccount {
    availableAlerts: unknown;
    /** Per-`dataset.field` usage; a field absent from `sumFields` is not exposed by the schema at all. */
    graphqlStatus?: number;
    history: unknown[];
    policies: Policy[];
    /** `METHOD /path` → a canned failure, checked before the default routes. */
    restOverrides?: Record<string, FakeReply>;
    sumFields: Record<string, string[]>;
    usage: Record<string, number>;
    webhooks: { id: string; last_failure?: string; last_success?: string; name: string }[];
}

interface Call {
    body: unknown;
    method: string;
    url: string;
}

const ok = (result: unknown): FakeReply => {
    return { body: { errors: [], messages: [], result, success: true }, status: 200 };
};

/** Introspection answers for the path viewer → accounts → dataset → sum. */
const typeFields = (account: FakeAccount, typeName: string): { name: string; type: unknown }[] | undefined => {
    // Wrapped like a real schema: NON_NULL(LIST(NON_NULL(Named))) — the reader must unwrap.
    const wrapped = (name: string): unknown => {
        return { name: null, ofType: { name: null, ofType: { name: null, ofType: { name } } } };
    };

    if (typeName === "Query") {
        return [{ name: "viewer", type: { name: "viewer", ofType: null } }];
    }

    if (typeName === "viewer") {
        return [{ name: "accounts", type: wrapped("account") }];
    }

    if (typeName === "account") {
        return Object.keys(account.sumFields).map((dataset) => {
            return { name: dataset, type: wrapped(`${dataset}Group`) };
        });
    }

    if (typeName.endsWith("Group")) {
        return [{ name: "sum", type: { name: `${typeName.slice(0, -"Group".length)}Sum` } }];
    }

    if (typeName.endsWith("Sum")) {
        return (account.sumFields[typeName.slice(0, -"Sum".length)] ?? []).map((name) => {
            return { name, type: { name: "uint64" } };
        });
    }

    return undefined;
};

const graphqlReply = (account: FakeAccount, query: string): FakeReply => {
    if (query.includes("__schema")) {
        return { body: { data: { __schema: { queryType: { name: "Query" } } } }, status: 200 };
    }

    const typeName = /__type\(name: "(?<name>[^"]+)"\)/u.exec(query)?.groups?.["name"];

    if (typeName !== undefined) {
        const fields = typeFields(account, typeName);

        return { body: { data: { __type: fields === undefined ? null : { fields } } }, status: 200 };
    }

    // `… <dataset>(limit: 1, filter: …) { sum { <field> } } …`
    const beforeArguments = query.slice(0, query.indexOf("(limit: 1"));
    const dataset = beforeArguments.slice(beforeArguments.lastIndexOf(" ") + 1);
    const field = query.slice(query.indexOf("sum { ") + "sum { ".length).split(" ")[0] ?? "";

    if (!(account.sumFields[dataset] ?? []).includes(field)) {
        return { body: { data: null, errors: [{ message: `unknown field "${field}"` }] }, status: 200 };
    }

    const value = account.usage[`${dataset}.${field}`];

    return { body: { data: { viewer: { accounts: [{ [dataset]: value === undefined ? [] : [{ sum: { [field]: value } }] }] } } }, status: 200 };
};

const restReply = (account: FakeAccount, method: string, path: string, body: unknown): FakeReply => {
    const override = account.restOverrides?.[`${method} ${path}`];

    if (override !== undefined) {
        return override;
    }

    if (path === "/alerting/v3/policies" && method === "GET") {
        return ok(account.policies);
    }

    if (path === "/alerting/v3/policies" && method === "POST") {
        const id = `new-${String(account.policies.length + 1)}`;

        account.policies.push({ ...(body as Policy), id });

        return ok({ id });
    }

    if (path.startsWith("/alerting/v3/policies/") && method === "PUT") {
        const id = path.slice("/alerting/v3/policies/".length);

        account.policies.splice(
            account.policies.findIndex((policy) => policy.id === id),
            1,
            { ...(body as Policy), id },
        );

        return ok({ id });
    }

    if (path === "/alerting/v3/available_alerts") {
        return ok(account.availableAlerts);
    }

    if (path === "/alerting/v3/destinations/webhooks") {
        return ok(account.webhooks);
    }

    if (path.startsWith("/alerting/v3/destinations/webhooks/")) {
        const hook = account.webhooks.find((entry) => entry.id === path.slice("/alerting/v3/destinations/webhooks/".length));

        return hook === undefined ? { body: { errors: [{ code: 1003, message: "Not found" }], success: false }, status: 404 } : ok(hook);
    }

    if (path.startsWith("/alerting/v3/history")) {
        return ok(account.history);
    }

    return { body: { errors: [{ message: `unrouted ${method} ${path}` }], success: false }, status: 404 };
};

const replyFor = (account: FakeAccount, method: string, url: string, body: unknown): FakeReply => {
    if (url !== GRAPHQL_URL) {
        return restReply(account, method, url.slice(REST_PREFIX.length), body);
    }

    if (account.graphqlStatus !== undefined) {
        return { body: { errors: [{ message: "not authorized" }] }, status: account.graphqlStatus };
    }

    return graphqlReply(account, (body as { query: string }).query);
};

const fakeCloudflare =
    (account: FakeAccount, calls: Call[]): typeof globalThis.fetch =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;

        calls.push({ body, method, url });

        const reply = replyFor(account, method, url, body);

        return Response.json(reply.body, { status: reply.status });
    };

/** An account with history for every metric whose field is published, and discoverable products. */
const baseAccount = (overrides: Partial<FakeAccount> = {}): FakeAccount => {
    return {
        availableAlerts: availableAlerts(PRODUCT_OPTIONS),
        history: [],
        policies: [],
        sumFields: {
            d1AnalyticsAdaptiveGroups: ["rowsRead", "rowsWritten", "readQueries"],
            durableObjectsInvocationsAdaptiveGroups: ["requests"],
            durableObjectsPeriodicGroups: ["cpuTime"],
            workersInvocationsAdaptive: ["requests", "errors"],
        },
        usage: {
            // eslint-disable-next-line no-secrets/no-secrets -- a GraphQL dataset.field key, not a credential
            "durableObjectsInvocationsAdaptiveGroups.requests": 2_500_000,
            "workersInvocationsAdaptive.requests": 12_345_678,
        },
        webhooks: [],
        ...overrides,
    };
};

const captureLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (level: string) =>
        (message: string): void => {
            lines.push(`${level}: ${message}`);
        };

    return { lines, logger: { error: push("error"), info: push("info"), success: push("success"), warn: push("warn") } };
};

const writes = (calls: Call[]): Call[] => calls.filter((call) => call.method !== "GET" && call.url !== GRAPHQL_URL);

describe("lunora alerts", () => {
    let cwd: string;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-alerts-"));
    });

    afterEach(() => {
        rmSync(cwd, { force: true, recursive: true });
    });

    const run = async (
        account: FakeAccount,
        options: Partial<AlertsCommandOptions> & Pick<AlertsCommandOptions, "subcommand">,
        environment?: Record<string, string>,
    ) => {
        const calls: Call[] = [];
        const { lines, logger } = captureLogger();
        const result = await runAlertsCommand({
            confirm: async () => true,
            cwd,
            environment: environment ?? { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "tok" },
            fetch: fakeCloudflare(account, calls),
            logger,
            now: new Date("2026-10-09T12:00:00Z"),
            ...options,
        });

        return { calls, output: lines.join("\n"), result };
    };

    describe("status", () => {
        it("reports last month's usage per product and which products already have an alert", async () => {
            expect.assertions(6);

            const account = baseAccount({
                policies: [{ alert_type: "billing_usage_alert", filters: { limit: ["50000000"], product: ["prod_workers_req"] }, id: "p1", name: "Mine" }],
            });
            const { output, result } = await run(account, { subcommand: "status" });
            const workers = result.data?.metrics?.find((metric) => metric.id === "workers-requests");

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(result.data?.period).toStrictEqual({ endDate: "2026-09-30", startDate: "2026-09-01" });
            expect(workers?.usage).toMatchObject({ status: "ok", value: 12_345_678 });
            expect(workers?.alerts).toStrictEqual([{ id: "p1", limit: ["50000000"], name: "Mine" }]);
            expect(output).toContain("Durable Objects requests: 2,500,000 — alert: none");
            expect(output).toContain("Create it in the dashboard: Manage Account > Billing > Billable Usage");
        });

        it("never queries a field the schema does not expose — the metric is reported unavailable instead", async () => {
            expect.assertions(3);

            const { calls, result } = await run(baseAccount(), { subcommand: "status" });
            const cpu = result.data?.metrics?.find((metric) => metric.id === "workers-cpu");
            const usageQueries = calls.filter((call) => call.url === GRAPHQL_URL).map((call) => (call.body as { query: string }).query);

            expect(cpu?.usage).toMatchObject({ reason: expect.stringContaining("exposes no `cpuTimeUs` field"), status: "unavailable" });
            expect(usageQueries.some((query) => query.includes("cpuTimeUs") && !query.includes("__type"))).toBe(false);
            expect(usageQueries.some((query) => query.includes("sum { requests }"))).toBe(true);
        });

        it("names the missing Account Analytics Read permission when the analytics API refuses, and still reports the policies", async () => {
            expect.assertions(3);

            const { output, result } = await run(baseAccount({ graphqlStatus: 403 }), { subcommand: "status" });

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(output).toContain('needs the "Account Analytics Read" permission');
            expect(result.data?.metrics?.every((metric) => metric.usage.status === "unavailable")).toBe(true);
        });

        it("names the missing Notifications Write permission when the policy list is refused", async () => {
            expect.assertions(2);

            const account = baseAccount({
                restOverrides: {
                    "GET /alerting/v3/policies": { body: { errors: [{ code: 10_000, message: "Authentication error" }], success: false }, status: 403 },
                },
            });
            const { result } = await run(account, { subcommand: "status" });

            expect(result.code).toBe(EXIT_CODE.PERMISSION);
            expect(result.error).toBe(
                'Listing notification policies failed (HTTP 403): Authentication error — the API token needs the "Notifications Write" permission on this account.',
            );
        });

        it("treats Cloudflare's malformed-token answer (HTTP 400, code 9106) as an authentication failure", async () => {
            expect.assertions(2);

            // The envelope the live API returned for a malformed bearer token.
            const account = baseAccount({
                restOverrides: {
                    "GET /alerting/v3/policies": {
                        body: { errors: [{ code: 9106, message: "Authentication failed (status: 400)" }], messages: [], result: null, success: false },
                        status: 400,
                    },
                },
            });
            const { result } = await run(account, { subcommand: "status" });

            expect(result.code).toBe(EXIT_CODE.AUTH);
            expect(result.error).toContain('needs the "Notifications Write" permission');
        });

        it("stops before any call without CLOUDFLARE_API_TOKEN, naming both permissions", async () => {
            expect.assertions(3);

            const { calls, result } = await run(baseAccount(), { subcommand: "status" }, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });

            expect(result.code).toBe(EXIT_CODE.AUTH);
            expect(result.error).toContain('"Notifications Write" and "Account Analytics Read"');
            expect(calls).toHaveLength(0);
        });
    });

    describe("setup", () => {
        it("creates one policy per discovered product at multiplier × last month, with floors and no history handled", async () => {
            expect.assertions(4);

            const account = baseAccount();
            const { calls, result } = await run(account, { emails: ["ops@example.com"], subcommand: "setup", yes: true });
            const created = writes(calls).map((call) => call.body as Policy);

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            // 12,345,678 × 3 = 37,037,034 → rounded up to 38,000,000; DO requests 2.5M × 3 = 7.5M.
            expect(created.map((policy) => [policy.name, policy.filters])).toStrictEqual([
                ["Lunora usage: Workers requests", { limit: ["38000000"], product: ["prod_workers_req"] }],
                // The schema exposes no CPU sum, so no history: the floor (30M ms, the included allowance).
                ["Lunora usage: Workers CPU time", { limit: ["30000000"], product: ["prod_workers_cpu"] }],
                ["Lunora usage: Durable Objects requests", { limit: ["7500000"], product: ["prod_do_req"] }],
            ]);
            expect(created[0]?.mechanisms).toStrictEqual({ email: [{ id: "ops@example.com" }] });
            expect(result.data?.plan?.alerts.map((alert) => alert.basis)).toStrictEqual(["history", "floor", "history"]);
        });

        it("is idempotent: an up-to-date policy is left alone, a changed one is updated in place", async () => {
            expect.assertions(4);

            const account = baseAccount();

            await run(account, { emails: ["ops@example.com"], subcommand: "setup", yes: true });

            const again = await run(account, { emails: ["ops@example.com"], subcommand: "setup", yes: true });

            expect(writes(again.calls)).toHaveLength(0);
            expect(again.output).toContain("Every alert is already up to date.");

            const bigger = await run(account, { emails: ["ops@example.com"], multiplier: "10", subcommand: "setup", yes: true });

            expect(writes(bigger.calls).map((call) => `${call.method} ${call.url.slice(REST_PREFIX.length)}`)).toStrictEqual([
                "PUT /alerting/v3/policies/new-1",
                // CPU has no history, so its floor — and its policy — does not move with the multiplier.
                "PUT /alerting/v3/policies/new-3",
            ]);
            expect(account.policies).toHaveLength(3);
        });

        it("--dry-run shows the plan and writes nothing", async () => {
            expect.assertions(4);

            const { calls, output, result } = await run(baseAccount(), { dryRun: true, emails: ["ops@example.com"], subcommand: "setup" });

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(writes(calls)).toHaveLength(0);
            expect(output).toContain("create    Lunora usage: Workers requests — product prod_workers_req, limit 38,000,000 (last month 12,345,678)");
            expect(output).toContain("Cloudflare does not document the unit of a usage alert's limit");
        });

        it("refuses an ineligible plan without trying to create anything", async () => {
            expect.assertions(3);

            const { calls, output, result } = await run(baseAccount({ availableAlerts: { Origin: [{ type: "http_alert_origin_error" }] } }), {
                emails: ["ops@example.com"],
                subcommand: "setup",
                yes: true,
            });

            expect(result.code).toBe(EXIT_CODE.PERMISSION);
            expect(output).toContain("Pay-as-you-go");
            expect(writes(calls)).toHaveLength(0);
        });

        it("creates nothing when no product identifier can be discovered, and points at the dashboard", async () => {
            expect.assertions(3);

            const { calls, result } = await run(baseAccount({ availableAlerts: availableAlerts([]) }), {
                emails: ["ops@example.com"],
                subcommand: "setup",
                yes: true,
            });

            expect(result.code).toBe(EXIT_CODE.FAILURE);
            expect(result.error).toContain("Alerts > Overview > Create an Alert");
            expect(writes(calls)).toHaveLength(0);
        });

        it("discovers a product from a policy made in the dashboard when the alert type lists none", async () => {
            expect.assertions(2);

            const account = baseAccount({
                availableAlerts: availableAlerts([]),
                policies: [
                    { alert_type: "billing_usage_alert", filters: { limit: ["1"], product: ["durable_objects_requests"] }, id: "dash", name: "From dashboard" },
                ],
            });
            const { result } = await run(account, { emails: ["ops@example.com"], subcommand: "setup", yes: true });

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            // The product is already alerted by the user's own policy, so it is skipped rather than doubled.
            expect(result.data?.plan?.skipped).toContainEqual({
                kind: "covered",
                metric: "do-requests",
                reason: 'already alerted by the existing policy "From dashboard"',
            });
        });

        it("surfaces Cloudflare's validation message when a create is rejected", async () => {
            expect.assertions(2);

            const account = baseAccount({
                restOverrides: {
                    "POST /alerting/v3/policies": { body: { errors: [{ code: 17_000, message: "invalid filter: product" }], success: false }, status: 400 },
                },
            });
            const { result } = await run(account, { emails: ["ops@example.com"], subcommand: "setup", yes: true });

            expect(result.code).toBe(EXIT_CODE.USAGE);
            expect(result.error).toContain("invalid filter: product");
        });

        it("asks before writing, and a declined prompt changes nothing", async () => {
            expect.assertions(2);

            const { calls, result } = await run(baseAccount(), { confirm: async () => false, emails: ["ops@example.com"], subcommand: "setup" });

            expect(result.code).toBe(EXIT_CODE.CANCELLED);
            expect(writes(calls)).toHaveLength(0);
        });

        it("refuses to write without --yes when it cannot ask (stdin is not a TTY)", async () => {
            expect.assertions(3);

            const tty = process.stdin.isTTY;

            process.stdin.isTTY = false;

            try {
                const { calls, result } = await run(baseAccount(), { confirm: undefined, emails: ["ops@example.com"], subcommand: "setup" });

                expect(result.code).toBe(EXIT_CODE.USAGE);
                expect(result.error).toContain("re-run with --yes");
                expect(writes(calls)).toHaveLength(0);
            } finally {
                process.stdin.isTTY = tty;
            }
        });

        it("never prompts under --format json, where stdout belongs to the document", async () => {
            expect.assertions(2);

            const tty = process.stdin.isTTY;

            // A real terminal: only the json format may stop the prompt.
            process.stdin.isTTY = true;

            try {
                const { calls, result } = await run(baseAccount(), { confirm: undefined, emails: ["ops@example.com"], format: "json", subcommand: "setup" });

                expect(result.code).toBe(EXIT_CODE.USAGE);
                expect(writes(calls)).toHaveLength(0);
            } finally {
                process.stdin.isTTY = tty;
            }
        });

        it("rejects an unknown --webhook before planning", async () => {
            expect.assertions(2);

            const { calls, result } = await run(baseAccount(), { subcommand: "setup", webhooks: ["nope"], yes: true });

            expect(result.code).toBe(EXIT_CODE.USAGE);
            expect(writes(calls)).toHaveLength(0);
        });

        it("needs a destination", async () => {
            expect.assertions(1);

            const { result } = await run(baseAccount(), { subcommand: "setup", yes: true });

            expect(result.code).toBe(EXIT_CODE.USAGE);
        });
    });

    describe("test", () => {
        it("sends no test (there is no API for one) and reports what Cloudflare actually delivered", async () => {
            expect.assertions(6);

            const account = baseAccount({
                history: [
                    {
                        mechanism: "https://hooks.example/x",
                        mechanism_type: "webhook",
                        name: "Lunora usage: Workers requests",
                        policy_id: "p1",
                        sent: "2026-10-01T00:00:00Z",
                    },
                ],
                policies: [
                    {
                        alert_type: "billing_usage_alert",
                        filters: { limit: ["1"], product: ["prod_workers_req"] },
                        id: "p1",
                        mechanisms: { email: [{ id: "ops@example.com" }], webhooks: [{ id: "wh1" }] },
                        name: "Lunora usage: Workers requests",
                    },
                ],
                webhooks: [{ id: "wh1", last_success: "2026-10-01T00:00:01Z", name: "pager" }],
            });
            const { calls, output, result } = await run(account, { subcommand: "test" });

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(result.data?.deliveries?.testSent).toBe(false);
            expect(calls.every((call) => call.method === "GET" || call.url === GRAPHQL_URL)).toBe(true);
            expect(output).toContain('webhook "pager" (generic): last delivered 2026-10-01T00:00:01Z, last failed never');
            expect(output).toContain("Email destinations cannot be tested at all");
            expect(output).toContain("has no endpoint that sends a test notification");
        });
    });
});

describe("alert planning", () => {
    it("rounds thresholds up to two significant figures", () => {
        expect.assertions(4);

        expect(roundUpNice(37_037_034)).toBe(38_000_000);
        expect(roundUpNice(7_500_000)).toBe(7_500_000);
        expect(roundUpNice(99)).toBe(99);
        expect(roundUpNice(0)).toBe(0);
    });

    it("never goes below the floor, and uses it alone without history", () => {
        expect.assertions(3);

        expect(thresholdFor(100, 3, 10_000_000)).toStrictEqual({ basis: "floor", threshold: 10_000_000 });
        expect(thresholdFor(undefined, 3, 10_000_000)).toStrictEqual({ basis: "floor", threshold: 10_000_000 });
        expect(thresholdFor(20_000_000, 3, 10_000_000)).toStrictEqual({ basis: "history", threshold: 60_000_000 });
    });

    it("converts a CPU total in microseconds to a millisecond limit only when the product says it is in ms", () => {
        expect.assertions(2);

        const usage: MetricUsage[] = [
            {
                // eslint-disable-next-line no-secrets/no-secrets -- a GraphQL dataset.field path, not a credential
                field: "workersInvocationsAdaptive.sum.cpuTimeUs",
                id: "workers-cpu",
                label: "Workers CPU time",
                status: "ok",
                unit: "microseconds",
                value: 40_000_000_000,
            },
        ];
        const withUnit = planAlerts({
            emails: ["a@b.co"],
            multiplier: 3,
            policies: [],
            products: [{ id: "cpu", label: "Workers CPU", source: "available-alerts", unit: "ms" }],
            usage,
            webhooks: [],
        });
        const withoutUnit = planAlerts({
            emails: ["a@b.co"],
            multiplier: 3,
            policies: [],
            products: [{ id: "cpu", label: "Workers CPU", source: "available-alerts" }],
            usage,
            webhooks: [],
        });

        // 40e9 µs = 40e6 ms, × 3 = 120e6 ms.
        expect(withUnit.alerts.map((alert) => alert.body.filters.limit)).toStrictEqual([["120000000"]]);
        expect(withoutUnit.skipped.filter((skip) => skip.metric === "workers-cpu")).toStrictEqual([
            {
                kind: "unit-unknown",
                metric: "workers-cpu",
                reason: 'product "cpu" does not state the unit of its limit, so a threshold could be off by a factor of 1000',
            },
        ]);
    });

    it("leaves a product ambiguous rather than picking one", () => {
        expect.assertions(1);

        const plan = planAlerts({
            emails: ["a@b.co"],
            multiplier: 3,
            policies: [],
            products: [
                { id: "workers_requests_a", source: "available-alerts" },
                { id: "workers_requests_b", source: "available-alerts" },
            ],
            usage: [],
            webhooks: [],
        });

        expect(plan.skipped.find((skip) => skip.metric === "workers-requests")?.kind).toBe("unmatched");
    });
});

describe("product discovery", () => {
    it("reads an explicit product list out of filter_options, and nothing from an unrelated shape", () => {
        expect.assertions(3);

        expect(discoverProducts(availableAlerts(PRODUCT_OPTIONS), true, []).products.map((product) => product.id)).toStrictEqual([
            "prod_workers_req",
            "prod_workers_cpu",
            "prod_do_req",
        ]);
        expect(discoverProducts(availableAlerts([{ key: "limit", values: ["1"] }, "free text"]), true, []).products).toStrictEqual([]);
        expect(discoverProducts(undefined, false, []).eligible).toBeUndefined();
    });
});

describe("previousMonth", () => {
    it("spans the whole previous calendar month, across a year boundary", () => {
        expect.assertions(1);

        expect(previousMonth(new Date("2026-01-15T00:00:00Z"))).toStrictEqual({ endDate: "2025-12-31", startDate: "2025-12-01" });
    });
});
