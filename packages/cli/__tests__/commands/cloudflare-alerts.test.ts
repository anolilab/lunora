import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli";
import type { AlertsCommandOptions } from "../../src/commands/cloudflare/alerts/handler";
import { runAlertsCommand } from "../../src/commands/cloudflare/alerts/handler";
import type { Policy } from "../../src/commands/cloudflare/alerts/plan";
import { planAlerts, roundUpNice, thresholdFor } from "../../src/commands/cloudflare/alerts/plan";
import { discoverProducts, matchProduct } from "../../src/commands/cloudflare/alerts/products";
import { previousMonth } from "../../src/commands/cloudflare/alerts/usage";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";

const ACCOUNT = "acc123";
const REST_PREFIX = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/**
 * The `GET /alerting/v3/available_alerts` example from Cloudflare's OpenAPI
 * schema (`components.schemas["aaa_alerts-response_collection"]`, result
 * example), copied verbatim: PascalCase filter-option keys.
 * @see https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json
 */
const OPENAPI_AVAILABLE_ALERTS_EXAMPLE = {
    "Origin Monitoring": [
        {
            description: "High levels of 5xx HTTP errors at your origin.",
            display_name: "Origin Error Rate Alert",
            filter_options: [
                { AvailableValues: null, ComparisonOperator: "==", Key: "zones", Range: "1-n" },
                {
                    AvailableValues: [
                        { Description: "Service-Level Objective of 99.7", ID: "99.7" },
                        { Description: "Service-Level Objective of 99.8", ID: "99.8" },
                    ],
                    ComparisonOperator: ">=",
                    Key: "slo",
                    Range: "0-1",
                },
            ],
            type: "http_alert_origin_error",
        },
    ],
};

/**
 * A `billing_usage_alert` entry in the same PascalCase shape (constructed — the
 * OpenAPI example has none), offering two of the documented product ids and
 * one undocumented one.
 */
const billingAlertType = (values: { Description: string; ID: string }[] | null): unknown => {
    return {
        description: "Usage Based Billing",
        display_name: "Usage Based Billing",
        filter_options: [
            { AvailableValues: values, ComparisonOperator: "==", Key: "product", Range: "1-1" },
            { AvailableValues: null, ComparisonOperator: ">", Key: "limit", Range: "1-1" },
        ],
        type: "billing_usage_alert",
    };
};

const availableAlerts = (values: { Description: string; ID: string }[] | null = null): unknown => {
    return { ...OPENAPI_AVAILABLE_ALERTS_EXAMPLE, Billing: [billingAlertType(values)] };
};

interface FakeReply {
    body: unknown;
    status: number;
}

interface FakeAccount {
    availableAlerts: unknown;
    graphqlStatus?: number;
    /** Notification history, one array per page. */
    historyPages: unknown[][];
    policies: Policy[];
    /** `METHOD /path` → a canned failure, checked before the default routes. */
    restOverrides?: Record<string, FakeReply>;
    /** Simulate Cloudflare normalising a written limit. */
    storeLimitAs?: string[];
    /** Per dataset, the `sum` fields the schema exposes. */
    sumFields: Record<string, string[]>;
    /** Per `dataset.field` usage; absent means an empty result (a real zero). */
    usage: Record<string, number>;
    webhooks: { id: string; last_failure?: string; last_success?: string; name: string }[];
}

interface Call {
    body: unknown;
    method: string;
    url: string;
}

const ok = (result: unknown, extra: Record<string, unknown> = {}): FakeReply => {
    return { body: { errors: [], messages: [], result, success: true, ...extra }, status: 200 };
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

const store = (account: FakeAccount, body: unknown, id: string): Policy => {
    const policy = { ...(body as Policy), id };

    return account.storeLimitAs === undefined ? policy : { ...policy, filters: { ...policy.filters, limit: account.storeLimitAs } };
};

const POLICY_PATH = "/alerting/v3/policies/";

const restReply = (account: FakeAccount, method: string, path: string, body: unknown): FakeReply => {
    const override = account.restOverrides?.[`${method} ${path}`];

    if (override !== undefined) {
        return override;
    }

    if (path === "/alerting/v3/policies") {
        if (method === "GET") {
            return ok(account.policies);
        }

        const id = `new-${String(account.policies.length + 1)}`;

        account.policies.push(store(account, body, id));

        return ok({ id });
    }

    if (path.startsWith(POLICY_PATH)) {
        const id = path.slice(POLICY_PATH.length);
        const index = account.policies.findIndex((policy) => policy.id === id);

        if (method === "PUT") {
            account.policies.splice(index, 1, store(account, body, id));

            return ok({ id });
        }

        return ok(account.policies[index]);
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
        const page = Number(new URL(`https://x${path}`).searchParams.get("page") ?? "1");

        return ok(account.historyPages[page - 1] ?? [], { result_info: { page, total_pages: account.historyPages.length } });
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

/** An eligible account offering no product list (the documented ids apply), with history for both request metrics. */
const baseAccount = (overrides: Partial<FakeAccount> = {}): FakeAccount => {
    return {
        availableAlerts: availableAlerts(),
        historyPages: [],
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

const route = (call: Call): string => `${call.method} ${call.url.slice(REST_PREFIX.length)}`;

const billingPolicy = (overrides: Partial<Policy> & Pick<Policy, "id" | "name">): Policy => {
    return { alert_type: "billing_usage_alert", enabled: true, filters: { limit: ["1"], product: ["worker_requests"] }, ...overrides };
};

describe("lunora cloudflare alerts", () => {
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

    const setup = async (account: FakeAccount, options: Partial<AlertsCommandOptions> = {}) =>
        run(account, { emails: ["ops@example.com"], subcommand: "setup", yes: true, ...options });

    describe("the cloudflare group", () => {
        /** Run the real CLI in `cwd` with a capturing logger; the CLI's own env has no token, so a reached alerts run stops at AUTH. */
        const cli = async (argv: string[]): Promise<{ code: number; output: string }> => {
            const lines: string[] = [];
            const push = (...values: unknown[]): void => {
                lines.push(values.map(String).join(" "));
            };
            const code = await runCli({ argv, cwd, logger: { debug: push, error: push, info: push, log: push, warn: push } as unknown as Console });

            return { code, output: lines.join("\n") };
        };

        it.each(["cloudflare alerts", "cloudflare alert", "cloudflare alert test"])("`lunora %s` reaches the alerts tool", async (line) => {
            expect.assertions(2);

            const { code, output } = await cli(line.split(" "));

            expect(code).toBe(EXIT_CODE.AUTH);
            expect(output).toContain("`lunora cloudflare alerts` calls the Cloudflare API");
        });

        it("refuses an unknown alerts subcommand", async () => {
            expect.assertions(2);

            const sub = await cli(["cloudflare", "alerts", "delete"]);

            expect(sub.code).toBe(EXIT_CODE.USAGE);
            expect(sub.output).toContain('cloudflare alerts: unknown subcommand "delete"');
        });
    });

    describe("status", () => {
        it("reports last month's usage per product and which products an enabled alert covers", async () => {
            expect.assertions(6);

            const account = baseAccount({
                policies: [billingPolicy({ filters: { limit: ["50000000"], product: ["worker_requests"] }, id: "p1", name: "Mine" })],
            });
            const { output, result } = await run(account, { subcommand: "status" });
            const workers = result.data?.metrics?.find((metric) => metric.id === "workers-requests");

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(result.data?.period).toStrictEqual({ endDate: "2026-09-30", nextStartDate: "2026-10-01", startDate: "2026-09-01" });
            expect(workers).toMatchObject({
                alerts: [{ enabled: true, id: "p1", limit: ["50000000"], name: "Mine" }],
                coverage: "active",
                product: "worker_requests",
            });
            expect(output).toContain("Durable Objects requests: 2,500,000 — alert: none");
            expect(output).toContain("Create it in the dashboard: Manage Account > Billing > Billable Usage");
            expect(result.data?.limitUnitCaveat).toContain("does not document the unit");
        });

        it("says Workers CPU and D1 have no usage alert at all, rather than that discovery failed", async () => {
            expect.assertions(3);

            const { output, result } = await run(baseAccount(), { subcommand: "status" });
            const coverage = Object.fromEntries((result.data?.metrics ?? []).map((metric) => [metric.id, metric.coverage]));

            expect(coverage).toMatchObject({ "d1-rows-read": "no-product", "d1-rows-written": "no-product", "workers-cpu": "no-product" });
            expect(coverage["workers-requests"]).toBe("none");
            expect(output).toContain("D1 rows read: 0 — alert: none possible — Cloudflare has no usage alert for this; the budget alert is its guard");
        });

        it("shows a disabled policy as not protecting anything", async () => {
            expect.assertions(2);

            const account = baseAccount({ policies: [billingPolicy({ enabled: false, id: "u1", name: "Old" })] });
            const { output, result } = await run(account, { subcommand: "status" });

            expect(result.data?.metrics?.find((metric) => metric.id === "workers-requests")?.coverage).toBe("disabled-only");
            expect(output).toContain('alert: none active; "Old" (limit ["1"]) — disabled, not protecting you');
        });

        it("never queries a field the schema does not expose, and bounds the month exclusively", async () => {
            expect.assertions(3);

            const { calls, result } = await run(baseAccount(), { subcommand: "status" });
            const queries = calls.filter((call) => call.url === GRAPHQL_URL).map((call) => (call.body as { query: string }).query);

            expect(result.data?.metrics?.find((metric) => metric.id === "workers-cpu")?.usage).toMatchObject({
                reason: expect.stringContaining("exposes no `cpuTimeUs` field"),
                status: "unavailable",
            });
            expect(queries.some((query) => query.includes("cpuTimeUs") && !query.includes("__type"))).toBe(false);
            expect(queries.find((query) => query.includes("workersInvocationsAdaptive(limit: 1"))).toContain(
                'datetime_geq: "2026-09-01T00:00:00Z", datetime_lt: "2026-10-01T00:00:00Z"',
            );
        });

        it("names the missing Account Analytics Read permission when the analytics API refuses, and still reports the policies", async () => {
            expect.assertions(3);

            const { output, result } = await run(baseAccount({ graphqlStatus: 403 }), { subcommand: "status" });

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(output).toContain('needs the "Account Analytics Read" permission');
            expect(result.data?.metrics?.every((metric) => metric.usage.status === "unavailable")).toBe(true);
        });

        it("names Notifications Read when the policy list is refused — reading is all status does", async () => {
            expect.assertions(2);

            const account = baseAccount({
                restOverrides: {
                    "GET /alerting/v3/policies": { body: { errors: [{ code: 10_000, message: "Authentication error" }], success: false }, status: 403 },
                },
            });
            const { result } = await run(account, { subcommand: "status" });

            expect(result.code).toBe(EXIT_CODE.PERMISSION);
            expect(result.error).toBe(
                'Listing notification policies failed (HTTP 403): Authentication error — the API token needs the "Notifications Read" permission on this account.',
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
            expect(result.error).toContain("check that CLOUDFLARE_API_TOKEN is a valid token");
        });

        it("stops before any call without CLOUDFLARE_API_TOKEN, naming the permissions", async () => {
            expect.assertions(3);

            const { calls, result } = await run(baseAccount(), { subcommand: "status" }, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });

            expect(result.code).toBe(EXIT_CODE.AUTH);
            expect(result.error).toContain('"Notifications Write" and "Account Analytics Read"');
            expect(calls).toHaveLength(0);
        });
    });

    describe("setup", () => {
        it("creates the request alerts under the documented product ids at multiplier × last month", async () => {
            expect.assertions(4);

            const account = baseAccount();
            const { calls, result } = await setup(account);
            const created = writes(calls).map((call) => call.body as Policy);

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            // 12,345,678 × 3 = 37,037,034 → 38,000,000; DO requests 2.5M × 3 = 7.5M.
            expect(created.map((policy) => [policy.name, policy.filters, policy.mechanisms])).toStrictEqual([
                ["Lunora usage: Workers requests", { limit: ["38000000"], product: ["worker_requests"] }, { email: [{ id: "ops@example.com" }] }],
                [
                    "Lunora usage: Durable Objects requests",
                    { limit: ["7500000"], product: ["worker_durable_objects_requests"] },
                    { email: [{ id: "ops@example.com" }] },
                ],
            ]);
            expect(result.data?.plan?.alerts.map((alert) => [alert.basis, alert.productSource])).toStrictEqual([
                ["history", "documented"],
                ["history", "documented"],
            ]);
            expect(Object.fromEntries((result.data?.plan?.skipped ?? []).map((skip) => [skip.metric, skip.kind]))).toStrictEqual({
                "d1-rows-read": "no-product",
                "d1-rows-written": "no-product",
                "do-duration": "unit-unverified",
                "do-rows-read": "unit-unverified",
                "do-rows-written": "unit-unverified",
                "workers-cpu": "no-product",
            });
        });

        it("prefers the id the account offers (PascalCase filter_options) over the documented one", async () => {
            expect.assertions(1);

            const account = baseAccount({ availableAlerts: availableAlerts([{ Description: "Workers Requests (standard)", ID: "workers_std_requests" }]) });
            const { calls } = await setup(account);

            expect(writes(calls).map((call) => (call.body as Policy).filters?.["product"])).toStrictEqual([
                ["workers_std_requests"],
                ["worker_durable_objects_requests"],
            ]);
        });

        it("sets a unit-unverified metric only at the limit the user gives", async () => {
            expect.assertions(2);

            const { calls, result } = await setup(baseAccount(), { thresholds: ["do-duration=500000"] });
            const duration = writes(calls).find((call) => (call.body as Policy).name === "Lunora usage: Durable Objects duration");

            expect((duration?.body as Policy | undefined)?.filters).toStrictEqual({ limit: ["500000"], product: ["worker_durable_objects_duration"] });
            expect(result.data?.plan?.alerts.find((alert) => alert.metric === "do-duration")?.basis).toBe("explicit");
        });

        it("refuses a --threshold for an unknown metric", async () => {
            expect.assertions(2);

            const { calls, result } = await setup(baseAccount(), { thresholds: ["workers-bandwidth=1"] });

            expect(result.code).toBe(EXIT_CODE.USAGE);
            expect(calls).toHaveLength(0);
        });

        it("writes nothing at the floor when usage could not be read, and fails", async () => {
            expect.assertions(3);

            const { calls, result } = await setup(baseAccount({ graphqlStatus: 403 }));

            expect(result.code).toBe(EXIT_CODE.FAILURE);
            expect(result.error).toContain("--allow-floor");
            expect(writes(calls)).toHaveLength(0);
        });

        it("applies the floor for unreadable usage only on --allow-floor, marked as such", async () => {
            expect.assertions(2);

            const { calls, result } = await setup(baseAccount({ graphqlStatus: 403 }), { allowFloor: true });

            expect(writes(calls).map((call) => (call.body as Policy).filters?.["limit"])).toStrictEqual([["10000000"], ["1000000"]]);
            expect(result.data?.plan?.alerts.map((alert) => alert.basis)).toStrictEqual(["floor-usage-unavailable", "floor-usage-unavailable"]);
        });

        it("treats a real zero as usage: the floor applies without a flag", async () => {
            expect.assertions(2);

            const { result } = await setup(baseAccount({ usage: {} }));

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(result.data?.plan?.alerts.map((alert) => [alert.basis, alert.threshold])).toStrictEqual([
                ["floor", 10_000_000],
                ["floor", 1_000_000],
            ]);
        });

        it("is idempotent: an up-to-date policy is left alone, a changed one is updated in place", async () => {
            expect.assertions(3);

            const account = baseAccount();

            await setup(account);

            const again = await setup(account);

            expect(writes(again.calls)).toHaveLength(0);
            expect(again.output).toContain("Every alert is already up to date.");

            const bigger = await setup(account, { multiplier: "10" });

            expect(writes(bigger.calls).map((call) => route(call))).toStrictEqual(["PUT /alerting/v3/policies/new-1", "PUT /alerting/v3/policies/new-2"]);
        });

        it("adds to an updated alert's recipients by default, keeping pagers and earlier addresses", async () => {
            expect.assertions(2);

            const account = baseAccount({
                policies: [
                    billingPolicy({
                        id: "p1",
                        mechanisms: { email: [{ id: "old@example.com" }], pagerduty: [{ id: "pd1" }] },
                        name: "Lunora usage: Workers requests",
                    }),
                ],
            });
            const { calls, result } = await setup(account);
            const put = writes(calls).find((call) => call.method === "PUT");

            expect((put?.body as Policy | undefined)?.mechanisms).toStrictEqual({
                email: [{ id: "old@example.com" }, { id: "ops@example.com" }],
                pagerduty: [{ id: "pd1" }],
            });
            expect(result.data?.plan?.alerts[0]?.recipients).toStrictEqual({ added: ["email:ops@example.com"], removed: [] });
        });

        it("replaces recipients only on --replace-recipients, and says so at the prompt", async () => {
            expect.assertions(2);

            const prompts: string[] = [];
            const account = baseAccount({
                policies: [billingPolicy({ id: "p1", mechanisms: { email: [{ id: "old@example.com" }] }, name: "Lunora usage: Workers requests" })],
            });
            const { calls } = await setup(account, {
                confirm: async (message) => {
                    prompts.push(message);

                    return true;
                },
                replaceRecipients: true,
                yes: false,
            });

            expect((writes(calls).find((call) => call.method === "PUT")?.body as Policy | undefined)?.mechanisms).toStrictEqual({
                email: [{ id: "ops@example.com" }],
            });
            expect(prompts[0]).toContain("This REMOVES recipients: email:old@example.com.");
        });

        it("does not count a disabled policy of the user's as coverage", async () => {
            expect.assertions(1);

            const account = baseAccount({ policies: [billingPolicy({ enabled: false, id: "u1", name: "Old" })] });
            const { calls } = await setup(account);

            expect(writes(calls).map((call) => (call.body as Policy).name)).toContain("Lunora usage: Workers requests");
        });

        it("leaves a product an enabled policy of the user's covers, warning when the limits differ by orders of magnitude", async () => {
            expect.assertions(3);

            const account = baseAccount({ policies: [billingPolicy({ filters: { limit: ["38"], product: ["worker_requests"] }, id: "u1", name: "Mine" })] });
            const { calls, output, result } = await setup(account);

            expect(writes(calls).map((call) => (call.body as Policy).name)).toStrictEqual(["Lunora usage: Durable Objects requests"]);
            expect(result.data?.plan?.skipped.find((skip) => skip.metric === "workers-requests")).toMatchObject({ kind: "covered" });
            expect(output).toContain("its limit 38 differs from the 38000000 this would plan by 1000000×");
        });

        it("finds its own policy by name, so a changed product updates it instead of adding a second", async () => {
            expect.assertions(3);

            const account = baseAccount({
                policies: [
                    billingPolicy({ filters: { limit: ["1"], product: ["old_product"] }, id: "p1", name: "Lunora usage: Workers requests" }),
                    billingPolicy({ id: "p9", name: "Lunora usage: Workers bandwidth" }),
                ],
            });
            const { calls, output, result } = await setup(account);

            expect(writes(calls).map((call) => route(call))).toStrictEqual(["PUT /alerting/v3/policies/p1", "POST /alerting/v3/policies"]);
            expect(result.data?.plan?.alerts[0]?.previousProduct).toStrictEqual(["old_product"]);
            expect(output).toContain(
                '"Lunora usage: Workers bandwidth" (p9) is named like a `lunora cloudflare alerts` policy but matches no metric; it was left alone.',
            );
        });

        it("reads every written policy back and flags a limit Cloudflare stored differently", async () => {
            expect.assertions(3);

            const { calls, output, result } = await setup(baseAccount({ storeLimitAs: ["38"] }));

            expect(calls.filter((call) => call.method === "GET" && /\/policies\/new-\d$/u.test(call.url))).toHaveLength(2);
            expect(result.data?.stored?.[0]).toMatchObject({ id: "new-1", limit: ["38"], product: ["worker_requests"] });
            expect(output).toContain('"Lunora usage: Workers requests": Cloudflare stored limit ["38"], not the ["38000000"] sent.');
        });

        it("--dry-run shows the plan and writes nothing", async () => {
            expect.assertions(4);

            const { calls, output, result } = await setup(baseAccount(), { dryRun: true, yes: false });

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(writes(calls)).toHaveLength(0);
            expect(output).toContain(
                "create    Lunora usage: Workers requests — product worker_requests (documented id), limit 38,000,000 (last month 12,345,678); recipients +email:ops@example.com",
            );
            expect(output).toContain("Cloudflare does not document the unit of a usage alert's limit");
        });

        it("refuses an ineligible plan without trying to create anything", async () => {
            expect.assertions(3);

            const { calls, output, result } = await setup(baseAccount({ availableAlerts: OPENAPI_AVAILABLE_ALERTS_EXAMPLE }));

            expect(result.code).toBe(EXIT_CODE.PERMISSION);
            expect(output).toContain("Pay-as-you-go");
            expect(writes(calls)).toHaveLength(0);
        });

        it("surfaces Cloudflare's validation message when a create is rejected", async () => {
            expect.assertions(2);

            const account = baseAccount({
                restOverrides: {
                    "POST /alerting/v3/policies": { body: { errors: [{ code: 17_000, message: "invalid filter: product" }], success: false }, status: 400 },
                },
            });
            const { result } = await setup(account);

            expect(result.code).toBe(EXIT_CODE.USAGE);
            expect(result.error).toContain("invalid filter: product");
        });

        it("asks before writing, and a declined prompt changes nothing", async () => {
            expect.assertions(2);

            const { calls, result } = await setup(baseAccount(), { confirm: async () => false, yes: false });

            expect(result.code).toBe(EXIT_CODE.CANCELLED);
            expect(writes(calls)).toHaveLength(0);
        });

        it("refuses to write without --yes when it cannot ask (stdin is not a TTY)", async () => {
            expect.assertions(3);

            const tty = process.stdin.isTTY;

            process.stdin.isTTY = false;

            try {
                const { calls, result } = await setup(baseAccount(), { confirm: undefined, yes: false });

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
                const { calls, result } = await setup(baseAccount(), { confirm: undefined, format: "json", yes: false });

                expect(result.code).toBe(EXIT_CODE.USAGE);
                expect(writes(calls)).toHaveLength(0);
            } finally {
                process.stdin.isTTY = tty;
            }
        });

        it("rejects an unknown --webhook before planning", async () => {
            expect.assertions(2);

            const { calls, result } = await setup(baseAccount(), { emails: [], webhooks: ["nope"] });

            expect(result.code).toBe(EXIT_CODE.USAGE);
            expect(writes(calls)).toHaveLength(0);
        });

        it("needs a destination", async () => {
            expect.assertions(1);

            const { result } = await setup(baseAccount(), { emails: [] });

            expect(result.code).toBe(EXIT_CODE.USAGE);
        });
    });

    describe("test", () => {
        const ownPolicy = billingPolicy({
            id: "p1",
            mechanisms: { email: [{ id: "ops@example.com" }], webhooks: [{ id: "wh1" }] },
            name: "Lunora usage: Workers requests",
        });

        it("sends no test (there is no API for one) and reports what Cloudflare actually delivered", async () => {
            expect.assertions(6);

            const account = baseAccount({
                historyPages: [
                    [
                        {
                            alert_type: "billing_usage_alert",
                            mechanism: "https://hooks.example/x",
                            mechanism_type: "webhook",
                            name: "Lunora usage: Workers requests",
                            policy_id: "p1",
                            sent: "2026-10-01T00:00:00Z",
                        },
                    ],
                ],
                policies: [ownPolicy],
                webhooks: [{ id: "wh1", last_success: "2026-10-01T00:00:01Z", name: "pager" }],
            });
            const { calls, output, result } = await run(account, { subcommand: "test" });

            expect(result.code).toBe(EXIT_CODE.SUCCESS);
            expect(result.data?.deliveries?.testSent).toBe(false);
            expect(calls.every((call) => call.method === "GET")).toBe(true);
            expect(output).toContain('webhook "pager" (generic): last delivered 2026-10-01T00:00:01Z, last failed never');
            expect(output).toContain("Email destinations cannot be tested at all");
            expect(output).toContain("has no endpoint that sends a test notification");
        });

        it("reads neither usage nor eligibility", async () => {
            expect.assertions(2);

            const { calls } = await run(baseAccount({ policies: [ownPolicy] }), { subcommand: "test" });

            expect(calls.some((call) => call.url === GRAPHQL_URL)).toBe(false);
            expect(calls.some((call) => call.url.endsWith("/available_alerts"))).toBe(false);
        });

        it("pages through the last 30 days of history and keeps only this command's billing alerts", async () => {
            expect.assertions(3);

            const mine = { alert_type: "billing_usage_alert", name: "Lunora usage: Workers requests", policy_id: "p1", sent: "2026-10-02T00:00:00Z" };
            const account = baseAccount({
                historyPages: [
                    [
                        { alert_type: "http_alert_origin_error", policy_id: "p1" },
                        { alert_type: "billing_usage_alert", policy_id: "other" },
                    ],
                    [mine],
                ],
                policies: [ownPolicy],
            });
            const { calls, result } = await run(account, { subcommand: "test" });
            const history = calls.filter((call) => call.url.includes("/alerting/v3/history")).map((call) => call.url);

            expect(history).toHaveLength(2);
            expect(history[0]).toContain(`since=${encodeURIComponent("2026-09-09T12:00:00.000Z")}`);
            expect(result.data?.deliveries?.history).toStrictEqual([mine]);
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

    it("never goes below the floor", () => {
        expect.assertions(2);

        expect(thresholdFor(100, 3, 10_000_000)).toStrictEqual({ basis: "floor", threshold: 10_000_000 });
        expect(thresholdFor(20_000_000, 3, 10_000_000)).toStrictEqual({ basis: "history", threshold: 60_000_000 });
    });

    it("leaves an undocumented product ambiguous rather than picking one", () => {
        expect.assertions(1);

        const plan = planAlerts({
            emails: ["a@b.co"],
            multiplier: 3,
            policies: [],
            products: [
                { id: "durable_requests_a", source: "available-alerts" },
                { id: "durable_requests_b", source: "available-alerts" },
            ],
            usage: [],
            webhooks: [],
        });

        expect(plan.skipped.find((skip) => skip.metric === "do-requests")?.kind).toBe("ambiguous");
    });
});

describe("product discovery", () => {
    it("reads nothing as a product from Cloudflare's OpenAPI example, and calls the account ineligible without the billing type", () => {
        expect.assertions(2);

        const discovery = discoverProducts(OPENAPI_AVAILABLE_ALERTS_EXAMPLE, true, []);

        expect(discovery.products).toStrictEqual([]);
        expect(discovery.eligible).toBe(false);
    });

    it("reads PascalCase Key/AvailableValues/ID/Description product lists", () => {
        expect.assertions(1);

        expect(discoverProducts(availableAlerts([{ Description: "Workers Requests", ID: "worker_requests" }]), true, []).products).toStrictEqual([
            { id: "worker_requests", label: "Workers Requests", source: "available-alerts" },
        ]);
    });

    it("uses the documented id when the account offers none, and has none for Workers CPU or D1", () => {
        expect.assertions(3);

        expect(matchProduct("workers-requests", [])).toStrictEqual({ product: { id: "worker_requests", source: "documented" }, status: "matched" });
        expect(matchProduct("workers-cpu", [])).toStrictEqual({ status: "no-product" });
        expect(matchProduct("d1-rows-written", [])).toStrictEqual({ status: "no-product" });
    });

    it("reports eligibility unknown when the alert types could not be read", () => {
        expect.assertions(1);

        expect(discoverProducts(undefined, false, []).eligible).toBeUndefined();
    });
});

describe("previousMonth", () => {
    it("spans the whole previous calendar month, across a year boundary, with an exclusive next-month bound", () => {
        expect.assertions(1);

        expect(previousMonth(new Date("2026-01-15T00:00:00Z"))).toStrictEqual({ endDate: "2025-12-31", nextStartDate: "2026-01-01", startDate: "2025-12-01" });
    });
});
