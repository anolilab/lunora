import { describe, expect, it } from "vitest";

import type { NotificationPolicy } from "../src/cloudflare/notifications";
import {
    coverageByProduct,
    discoverProducts,
    magnitudeMismatch,
    managedPolicyName,
    normalizeRecipients,
    planPolicyWrites,
    previousPeriodStart,
    PRODUCT_USAGE,
    proposeThreshold,
    PUBLISHED_PRODUCTS,
    roundUpNicely,
    thresholdError,
    usageOfPeriod,
} from "../src/cloudflare-accounts/usage-alerts";

const WORKERS = { description: "Workers requests", id: "worker_requests" };
const DO_REQUESTS = { description: "Durable Objects requests", id: "worker_durable_objects_requests" };
const DO_READS = { description: "Durable Objects storage reads", id: "worker_durable_objects_storage_reads" };

const policy = (overrides: Partial<NotificationPolicy>): NotificationPolicy => {
    return { alertType: "billing_usage_alert", enabled: true, filters: {}, id: "pol", mechanisms: {}, name: "mine", ...overrides };
};

describe("threshold proposals", () => {
    it("maps only published product ids to a usage, explicitly", () => {
        expect(Object.keys(PRODUCT_USAGE).toSorted((a, b) => a.localeCompare(b, "en"))).toStrictEqual(["worker_durable_objects_requests", "worker_requests"]);
        expect(PUBLISHED_PRODUCTS.map((product) => product.id)).toContain("worker_durable_objects_storage_reads");
        expect(PUBLISHED_PRODUCTS.some((product) => product.id.includes("d1"))).toBe(false);
    });

    it("rounds up to 1, 2 or 5 × 10ⁿ", () => {
        expect(roundUpNicely(30_000_001)).toBe(50_000_000);
        expect(roundUpNicely(120)).toBe(200);
        expect(roundUpNicely(5000)).toBe(5000);
        expect(roundUpNicely(0)).toBe(1);
    });

    it("proposes 3× last month, rounded, when that is above the included amount", () => {
        expect(proposeThreshold(WORKERS, { requests: 20_000_000 }, true)).toStrictEqual({ basis: "history", lastMonth: 20_000_000, limit: 100_000_000 });
    });

    it("never proposes below the included amount when last month was read back", () => {
        expect(proposeThreshold(WORKERS, { requests: 1000 }, true)).toStrictEqual({ basis: "floor", lastMonth: 1000, limit: 10_000_000 });
        expect(proposeThreshold(WORKERS, { requests: 0 }, true)).toStrictEqual({ basis: "floor", lastMonth: 0, limit: 10_000_000 });
    });

    it("says there is no data, rather than no usage, when nothing was read back", () => {
        // No rows for the meter, a token without Account Analytics, and a meter the readback does not count.
        expect(proposeThreshold(WORKERS, {}, true)).toStrictEqual({ basis: "no-data", lastMonth: null, limit: 10_000_000 });
        expect(proposeThreshold(WORKERS, { requests: 5 }, false)).toStrictEqual({ basis: "no-data", lastMonth: null, limit: 10_000_000 });
        expect(proposeThreshold(DO_REQUESTS, { doRequests: 9_000_000 }, true)).toStrictEqual({ basis: "no-data", lastMonth: null, limit: 1_000_000 });
    });

    it("proposes nothing where the unit is unverified", () => {
        expect(proposeThreshold(DO_READS, { doRowsRead: 1 }, true)).toStrictEqual({ basis: "unmapped", lastMonth: null, limit: null });
    });

    it("sums last month's ledger rows per meter, ignoring other months", () => {
        const september = Date.UTC(2026, 8, 1);

        expect(previousPeriodStart(Date.UTC(2026, 9, 9, 12))).toBe(september);
        expect(previousPeriodStart(Date.UTC(2026, 0, 15))).toBe(Date.UTC(2025, 11, 1));
        expect(
            usageOfPeriod(
                [
                    { kind: "requests", periodStart: september, quantity: 10 },
                    { kind: "requests", periodStart: september, quantity: 5 },
                    { kind: "requests", periodStart: Date.UTC(2026, 9, 1), quantity: 1000 },
                    { kind: "d1RowsRead", periodStart: september, quantity: 0 },
                ],
                september,
            ),
        ).toStrictEqual({ d1RowsRead: 0, requests: 15 });
    });
});

describe("product discovery and coverage", () => {
    it("offers Cloudflare's listed products, ids a policy stores, then the published ids", () => {
        const listed = [{ description: "Workers Standard Requests", id: "worker_requests" }];
        const policies = [
            policy({ filters: { limit: ["100"], product: ["worker_requests", "some_new_product"] }, id: "p1" }),
            policy({ alertType: "incident_alert", filters: { product: ["ignored"] }, id: "p2" }),
        ];
        const { products, source } = discoverProducts(listed, policies);

        expect(source).toBe("listed");
        expect(products.slice(0, 2)).toStrictEqual([listed[0], { description: "some_new_product", id: "some_new_product" }]);
        expect(products.map((product) => product.id)).not.toContain("ignored");
        expect(products).toHaveLength(2 + PUBLISHED_PRODUCTS.length - 1);
    });

    it("falls back to the published ids when Cloudflare lists none", () => {
        expect(discoverProducts([], [])).toStrictEqual({ products: [...PUBLISHED_PRODUCTS], source: "published" });
        expect(discoverProducts(null, []).source).toBe("published");
    });

    it("reports which policies cover each product, and whether Lunora manages them", () => {
        const covered = coverageByProduct([
            policy({ filters: { limit: ["100"], product: ["worker_requests"] }, id: "p1", name: "my alert" }),
            policy({ enabled: false, filters: { limit: ["5"], product: ["worker_requests"] }, id: "p2", name: managedPolicyName("worker_requests") }),
        ]);

        expect(covered.get("worker_requests")).toStrictEqual([
            { enabled: true, limit: "100", managed: false, name: "my alert", policyId: "p1" },
            { enabled: false, limit: "5", managed: true, name: managedPolicyName("worker_requests"), policyId: "p2" },
        ]);
        expect(covered.has("worker_durable_objects_requests")).toBe(false);
    });

    it("flags a threshold 100× or more away from the customer's own policy", () => {
        const coverage = [
            { limit: "100", managed: false },
            { limit: "1", managed: true },
        ];

        expect(magnitudeMismatch(10_000_000, coverage)).toBe("100");
        expect(magnitudeMismatch(5000, coverage)).toBeNull();
        expect(magnitudeMismatch(10_000_000, [{ limit: "100", managed: true }])).toBeNull();
    });
});

describe("policy writes", () => {
    it("creates a product's first managed policy and never touches the customer's own", () => {
        const [plan] = planPolicyWrites(
            [{ limit: 50_000_000, product: WORKERS }],
            [policy({ filters: { product: ["worker_requests"] }, id: "own" })],
            ["owner@example.com"],
        );

        expect(plan?.writes).toHaveLength(1);
        expect(plan?.writes[0]?.policyId).toBeUndefined();
        expect(plan?.writes[0]?.body).toMatchObject({
            alert_type: "billing_usage_alert",
            enabled: true,
            filters: { limit: ["50000000"], product: ["worker_requests"] },
            mechanisms: { email: [{ id: "owner@example.com" }] },
            name: "Lunora Cloud usage alert: worker_requests",
        });
        expect(plan?.writes[0]?.body.description).not.toContain("Edit or remove it from");
    });

    it("updates a managed policy keeping what the customer changed: off, interval, webhooks, extra addresses", () => {
        const managed = policy({
            alertInterval: "1h",
            enabled: false,
            filters: { product: ["worker_requests"] },
            id: "managed",
            mechanisms: { email: [{ id: "Finance@example.com" }, { id: "Owner@Example.com" }], pagerduty: [{ id: "pd" }], webhooks: [{ id: "wh" }] },
            name: managedPolicyName("worker_requests"),
        });
        const [plan] = planPolicyWrites([{ limit: 7, product: WORKERS }], [managed], ["owner@example.com", "admin@example.com"]);

        expect(plan).toMatchObject({ duplicates: 0, keptDestinations: 2, keptRecipients: ["Finance@example.com"] });
        expect(plan?.writes[0]).toMatchObject({
            body: {
                alert_interval: "1h",
                enabled: false,
                filters: { limit: ["7"] },
                mechanisms: {
                    email: [{ id: "Finance@example.com" }, { id: "Owner@Example.com" }, { id: "admin@example.com" }],
                    pagerduty: [{ id: "pd" }],
                    webhooks: [{ id: "wh" }],
                },
            },
            policyId: "managed",
        });
    });

    it("updates every managed policy of a product that two setups left, and counts the duplicates", () => {
        const name = managedPolicyName("worker_requests");
        const [plan] = planPolicyWrites(
            [{ limit: 9, product: WORKERS }],
            [policy({ id: "a", name }), policy({ id: "b", name }), policy({ id: "other", name: managedPolicyName("worker_durable_objects_requests") })],
            ["owner@example.com"],
        );

        expect(plan?.duplicates).toBe(1);
        expect(plan?.writes.map((write) => write.policyId)).toStrictEqual(["a", "b"]);
    });
});

describe("shared validation", () => {
    it("bounds a threshold with one message", () => {
        expect(thresholdError(5)).toBeNull();
        expect(thresholdError(0.5)).toMatch(/whole number from 1 to/u);
        expect(thresholdError(2e15)).toMatch(/whole number from 1 to/u);
    });

    it("reads Name <address> entries, names the bad one, and bounds the count", () => {
        expect(normalizeRecipients(["Jane Doe <Jane@Example.com>", " owner@example.com", "owner@example.com"])).toStrictEqual({
            addresses: ["jane@example.com", "owner@example.com"],
        });
        expect(normalizeRecipients(["owner@example.com", "not an address"])).toStrictEqual({ error: '"not an address" is not an email address' });
        expect(normalizeRecipients([])).toStrictEqual({ error: "name 1 to 10 email addresses" });
        expect(normalizeRecipients(Array.from({ length: 11 }, (_, index) => `u${String(index)}@example.com`))).toStrictEqual({
            error: "name 1 to 10 email addresses",
        });
    });
});
