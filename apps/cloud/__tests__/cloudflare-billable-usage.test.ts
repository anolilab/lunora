import { describe, expect, it, vi } from "vitest";

import type { BillableUsageRow } from "../src/cloudflare/billable-usage";
import { BillableUsageAuthError, fetchBillableUsage, normalizeBillableUsage } from "../src/cloudflare/billable-usage";

/** A CF envelope response with the given result rows. */
const envelopeResponse = (rows: unknown, init?: ResponseInit): Response =>
    Response.json({ errors: [], result: rows, success: true }, { headers: { "content-type": "application/json" }, ...init });

describe(normalizeBillableUsage, () => {
    it("keeps only the most recent charge period and groups by product", () => {
        const rows: BillableUsageRow[] = [
            { cost: 1.5, period_end: "2026-06-30", period_start: "2026-06-01", product: "Workers", quantity: 5, unit: "million requests" },
            { cost: 0.5, period_end: "2026-06-30", period_start: "2026-06-01", product: "Workers", quantity: 2, unit: "million requests" },
            { cost: 3, currency: "USD", period_end: "2026-06-30", period_start: "2026-06-01", product: "R2", quantity: 10, unit: "GB" },
            // An older period — must be excluded from the current-period view.
            { cost: 99, period_end: "2026-05-31", period_start: "2026-05-01", product: "Workers", quantity: 1 },
        ];

        const view = normalizeBillableUsage(rows);

        expect(view.periodStart).toBe("2026-06-01");
        expect(view.periodEnd).toBe("2026-06-30");
        // Workers 1.5 + 0.5 = 2.00 (200¢) + R2 3.00 (300¢) = 500¢. The old period's $99 is excluded.
        expect(view.totalMinor).toBe(500);
        // Sorted by cost descending: R2 (300¢) before Workers (200¢).
        expect(view.products.map((line) => line.product)).toStrictEqual(["R2", "Workers"]);

        const workers = view.products.find((line) => line.product === "Workers");

        expect(workers).toMatchObject({ costMinor: 200, quantity: 7, unit: "million requests" });
    });

    it("returns an empty view for no rows", () => {
        expect(normalizeBillableUsage([])).toStrictEqual({ currency: "USD", periodEnd: null, periodStart: null, products: [], totalMinor: 0 });
    });

    it("falls back to a single bucket and 'Unknown' product when rows carry no period/product", () => {
        const view = normalizeBillableUsage([{ amount: "2.25" }]);

        expect(view.totalMinor).toBe(225);
        expect(view.products).toHaveLength(1);
        expect(view.products[0]).toMatchObject({ costMinor: 225, product: "Unknown", quantity: null });
    });
});

describe(fetchBillableUsage, () => {
    it("requests the account's billable-usage endpoint with a bearer token and returns the rows", async () => {
        const rows = [{ cost: 1, product: "Workers" }];
        const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(envelopeResponse(rows));

        const result = await fetchBillableUsage({ accountId: "acc123", apiToken: "tok_secret", baseUrl: "https://api.test/client/v4", fetch: fetchImpl });

        expect(result).toStrictEqual(rows);

        const [url, init] = fetchImpl.mock.calls[0];

        expect(url).toBe("https://api.test/client/v4/accounts/acc123/billable-usage");
        expect(init).toMatchObject({ method: "GET" });
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok_secret");
    });

    it("throws BillableUsageAuthError on 403 (missing Billing Read scope)", async () => {
        const fetchImpl = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(Response.json({ errors: [{ message: "insufficient permissions" }], success: false }, { status: 403 }));

        await expect(fetchBillableUsage({ accountId: "a", apiToken: "t", fetch: fetchImpl })).rejects.toBeInstanceOf(BillableUsageAuthError);
    });

    it("throws a plain error on a non-ok, non-auth response", async () => {
        const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ errors: [{ message: "boom" }], success: false }, { status: 500 }));

        await expect(fetchBillableUsage({ accountId: "a", apiToken: "t", fetch: fetchImpl })).rejects.toThrow(/billable-usage read failed: boom/);
    });

    it("tolerates a non-array result by returning an empty list", async () => {
        const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(envelopeResponse(null));

        await expect(fetchBillableUsage({ accountId: "a", apiToken: "t", fetch: fetchImpl })).resolves.toStrictEqual([]);
    });
});
