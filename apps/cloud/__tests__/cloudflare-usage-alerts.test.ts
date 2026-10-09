import { describe, expect, it } from "vitest";

import type { NotificationPolicy } from "../src/cloudflare/notifications";
import {
    coverageByProduct,
    discoverProducts,
    managedPolicyName,
    METER_FLOORS,
    meterFor,
    normalizeRecipients,
    planPolicyWrites,
    previousPeriodStart,
    proposeThreshold,
    roundUpNicely,
    usageOfPeriod,
} from "../src/cloudflare-accounts/usage-alerts";

const WORKERS = { description: "Workers Standard Requests", id: "workers_requests" };
const D1_READ = { description: "D1 Rows Read", id: "d1_rows_read" };
const DO_REQUESTS = { description: "Durable Objects Requests", id: "do_requests" };
const ARGO = { description: "Argo Smart Routing", id: "argo" };

const policy = (overrides: Partial<NotificationPolicy>): NotificationPolicy => {
    return { alertType: "billing_usage_alert", enabled: true, filters: {}, id: "pol", name: "mine", ...overrides };
};

describe("threshold proposals", () => {
    it("matches a product to a meter by Cloudflare's own name, most specific first", () => {
        expect(meterFor(WORKERS)).toBe("requests");
        expect(meterFor(DO_REQUESTS)).toBe("doRequests");
        expect(meterFor(D1_READ)).toBe("d1RowsRead");
        expect(meterFor({ description: "Durable Objects Rows Written", id: "x" })).toBe("doRowsWritten");
        expect(meterFor(ARGO)).toBeNull();
    });

    it("rounds up to 1, 2 or 5 × 10ⁿ", () => {
        expect(roundUpNicely(30_000_001)).toBe(50_000_000);
        expect(roundUpNicely(120)).toBe(200);
        expect(roundUpNicely(5000)).toBe(5000);
        expect(roundUpNicely(0)).toBe(1);
    });

    it("proposes 3× last month, rounded, when that is above the meter's floor", () => {
        expect(proposeThreshold(WORKERS, { requests: 20_000_000 })).toStrictEqual({
            basis: "history",
            lastMonth: 20_000_000,
            limit: 100_000_000,
            meter: "requests",
        });
    });

    it("never proposes below the floor, and falls back to it without history", () => {
        expect(proposeThreshold(WORKERS, { requests: 1000 })).toStrictEqual({
            basis: "floor",
            lastMonth: 1000,
            limit: METER_FLOORS.requests,
            meter: "requests",
        });
        expect(proposeThreshold(D1_READ, {})).toStrictEqual({ basis: "floor", lastMonth: 0, limit: METER_FLOORS.d1RowsRead, meter: "d1RowsRead" });
    });

    it("proposes nothing for a product no meter maps to", () => {
        expect(proposeThreshold(ARGO, { requests: 1 })).toStrictEqual({ basis: "unmapped", lastMonth: null, limit: null, meter: null });
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
                    { kind: "d1RowsRead", periodStart: september, quantity: 7 },
                ],
                september,
            ),
        ).toStrictEqual({ d1RowsRead: 7, requests: 15 });
    });
});

describe("product discovery and coverage", () => {
    it("offers Cloudflare's listed products plus ids an existing policy already stores, and nothing else", () => {
        const policies = [
            policy({ filters: { limit: ["100"], product: ["workers_requests", "r2_class_a"] }, id: "p1" }),
            policy({ alertType: "incident_alert", filters: { product: ["ignored"] }, id: "p2" }),
        ];

        expect(discoverProducts([WORKERS], policies)).toStrictEqual([WORKERS, { description: "r2_class_a", id: "r2_class_a" }]);
        expect(discoverProducts(null, [])).toStrictEqual([]);
    });

    it("reports which policies cover each product, and whether Lunora manages them", () => {
        const covered = coverageByProduct([
            policy({ filters: { limit: ["100"], product: ["workers_requests"] }, id: "p1", name: "my alert" }),
            policy({ enabled: false, filters: { limit: ["5"], product: ["workers_requests"] }, id: "p2", name: managedPolicyName("workers_requests") }),
        ]);

        expect(covered.get("workers_requests")).toStrictEqual([
            { enabled: true, limit: "100", managed: false, name: "my alert", policyId: "p1" },
            { enabled: false, limit: "5", managed: true, name: managedPolicyName("workers_requests"), policyId: "p2" },
        ]);
        expect(covered.has("d1_rows_read")).toBe(false);
    });
});

describe("policy writes", () => {
    it("replaces the managed policy of a product, creates one where none exists, and never touches the customer's own", () => {
        const policies = [
            policy({ filters: { product: ["workers_requests"] }, id: "own", name: "my alert" }),
            policy({ filters: { product: ["d1_rows_read"] }, id: "managed", name: managedPolicyName("d1_rows_read") }),
        ];
        const writes = planPolicyWrites(
            [
                { limit: 50_000_000, product: WORKERS },
                { limit: 75_000_000_000, product: D1_READ },
            ],
            policies,
            ["owner@example.com"],
        );

        expect(writes.map((write) => [write.productId, write.policyId])).toStrictEqual([
            ["workers_requests", undefined],
            ["d1_rows_read", "managed"],
        ]);
        expect(writes[0]?.body).toMatchObject({
            alert_type: "billing_usage_alert",
            enabled: true,
            filters: { limit: ["50000000"], product: ["workers_requests"] },
            mechanisms: { email: [{ id: "owner@example.com" }] },
            name: "Lunora Cloud usage alert: workers_requests",
        });
    });

    it("normalizes recipients and refuses none, too many or a non-address", () => {
        expect(normalizeRecipients([" Owner@Example.com", "owner@example.com", "admin@example.com"])).toStrictEqual(["owner@example.com", "admin@example.com"]);
        expect(normalizeRecipients([])).toBeNull();
        expect(normalizeRecipients(["not an address"])).toBeNull();
        expect(normalizeRecipients(Array.from({ length: 11 }, (_, index) => `u${String(index)}@example.com`))).toBeNull();
    });
});
