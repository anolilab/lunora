import { describe, expect, it, vi } from "vitest";

import { billingProductsOf, classifyFailure, CloudflareNotificationsError, notificationsClient } from "../src/cloudflare/notifications";

const ACCOUNT = "a".repeat(32);
const TOKEN = "cf-token-that-must-never-leak-0123456789";
const ROOT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/alerting/v3`;

/** `available_alerts` as the API reference shows it: categories → alert types, each with `filter_options`. */
const AVAILABLE = {
    Billing: [
        {
            description: "Usage Based Billing",
            display_name: "Usage Based Billing",
            filter_options: [
                {
                    AvailableValues: [
                        { Description: "Workers Standard Requests", ID: "workers_requests" },
                        { Description: "D1 Rows Read", ID: "d1_rows_read" },
                    ],
                    ComparisonOperator: "==",
                    Key: "product",
                    Range: "1-n",
                },
                { AvailableValues: null, ComparisonOperator: ">=", Key: "limit", Range: "1-1" },
            ],
            type: "billing_usage_alert",
        },
    ],
    "Origin Monitoring": [{ display_name: "Origin Error Rate Alert", filter_options: [], type: "http_alert_origin_error" }],
};

const answer = (body: unknown, status = 200): Response => Response.json(body, { status });

const client = (fetch: typeof globalThis.fetch, timeoutMs?: number) =>
    notificationsClient({ accountId: ACCOUNT, apiToken: TOKEN, fetch, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

const failureOf = async (promise: Promise<unknown>): Promise<CloudflareNotificationsError> => {
    try {
        await promise;
    } catch (error) {
        if (error instanceof CloudflareNotificationsError) {
            return error;
        }

        throw error;
    }

    throw new Error("expected a failure");
};

describe("the Cloudflare Notifications client", () => {
    it("lists available alerts and reads the Usage Based Billing product values", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(answer({ result: AVAILABLE, success: true })));

        await expect(client(fetch).billingProducts()).resolves.toStrictEqual([
            { description: "Workers Standard Requests", id: "workers_requests" },
            { description: "D1 Rows Read", id: "d1_rows_read" },
        ]);

        const [url, init] = fetch.mock.calls[0] ?? [];

        expect(url).toBe(`${ROOT}/available_alerts`);
        expect(init?.method).toBe("GET");
        expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
        // Every call is bounded.
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("tells an alert type that names no products from one that is not offered", () => {
        expect(billingProductsOf({ Billing: [{ filter_options: [{ AvailableValues: null, Key: "product" }], type: "billing_usage_alert" }] })).toStrictEqual(
            [],
        );
        expect(billingProductsOf({ Billing: [{ type: "billing_usage_alert" }] })).toStrictEqual([]);
        expect(billingProductsOf({ "Origin Monitoring": AVAILABLE["Origin Monitoring"] })).toBeNull();
        expect(billingProductsOf(undefined)).toBeNull();
    });

    it("creates a policy with the documented body and answers its id", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(answer({ result: { id: "pol_1" }, success: true })));
        const body = {
            alert_type: "billing_usage_alert",
            enabled: true,
            filters: { limit: ["30000000"], product: ["workers_requests"] },
            mechanisms: { email: [{ id: "owner@example.com" }] },
            name: "Lunora Cloud usage alert: workers_requests",
        };

        await expect(client(fetch).createPolicy(body)).resolves.toBe("pol_1");

        const [url, init] = fetch.mock.calls[0] ?? [];

        expect(url).toBe(`${ROOT}/policies`);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(typeof init?.body === "string" ? init.body : "")).toStrictEqual(body);
    });

    it("replaces a policy by id with PUT", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(answer({ result: { id: "pol_1" }, success: true })));

        await client(fetch).updatePolicy("pol_1", { alert_type: "billing_usage_alert", enabled: true, mechanisms: {}, name: "n" });

        expect(fetch.mock.calls[0]?.[0]).toBe(`${ROOT}/policies/pol_1`);
        expect(fetch.mock.calls[0]?.[1]?.method).toBe("PUT");
    });

    it("lists policies across pages and keeps only the fields it reads", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>((input) => {
            const url = typeof input === "string" ? input : "";

            return Promise.resolve(
                url.endsWith("page=2")
                    ? answer({
                          result: [{ alert_type: "billing_usage_alert", filters: { product: ["d1_rows_read"] }, id: "p2", name: "two" }],
                          result_info: { page: 2, total_pages: 2 },
                          success: true,
                      })
                    : answer({
                          result: [{ alert_type: "incident_alert", enabled: false, id: "p1", name: "one" }, { name: "no id" }],
                          result_info: { page: 1, total_pages: 2 },
                          success: true,
                      }),
            );
        });

        await expect(client(fetch).listPolicies()).resolves.toStrictEqual([
            { alertType: "incident_alert", enabled: false, filters: {}, id: "p1", name: "one" },
            { alertType: "billing_usage_alert", enabled: true, filters: { product: ["d1_rows_read"] }, id: "p2", name: "two" },
        ]);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("classifies a refused token, an ineligible plan, a rejected body and a transient failure", async () => {
        const refusing = (status: number, message: string) =>
            vi.fn<typeof globalThis.fetch>(() => Promise.resolve(answer({ errors: [{ code: 10_000, message }], success: false }, status)));

        const scope = await failureOf(client(refusing(403, "Authentication error")).listPolicies());

        expect(scope).toMatchObject({ codes: [10_000], kind: "missing-scope", status: 403 });

        const kinds = await Promise.all(
            [
                refusing(403, "This feature is only available to Pay-as-you-go accounts"),
                refusing(400, "filters.limit must be a number"),
                refusing(503, "Service unavailable"),
                refusing(429, "Rate limited"),
            ].map(async (fetch) => {
                const failure = await failureOf(client(fetch).listPolicies());

                return failure.kind;
            }),
        );

        expect(kinds).toStrictEqual(["not-eligible", "validation", "transient", "transient"]);
        expect(classifyFailure(401, "Unauthorized")).toBe("missing-scope");
    });

    it("reports a timeout and a network failure as transient, and never echoes the token", async () => {
        const hanging = vi.fn<typeof globalThis.fetch>(
            (_input, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(init.signal?.reason as Error);
                    });
                }),
        );
        const timedOut = await failureOf(client(hanging, 5).listPolicies());

        expect(timedOut).toMatchObject({ kind: "transient", status: null });
        expect(timedOut.message).toContain("timed out");

        const offline = await failureOf(
            client(vi.fn<typeof globalThis.fetch>(() => Promise.reject(new TypeError(`fetch failed for ${TOKEN}`)))).listPolicies(),
        );

        expect(offline.kind).toBe("transient");
        expect(offline.message).not.toContain(TOKEN);
    });
});
