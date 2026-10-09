import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { UsageAlertsView } from "../src/client/CloudflareUsageAlerts";
import type { UsageAlertsOverview } from "../src/client/usage-alerts";
import { applyRequest, describeProposal, initialLimits, initialSelection, parseRecipients, STATE_COPY, summarizeResults } from "../src/client/usage-alerts";

/** The connected-account page's Cloudflare usage alerts: what it proposes, and what it says when it cannot. */

const ACCOUNT = "a".repeat(32);

const READY: UsageAlertsOverview = {
    dashboard: { budgetAlert: `https://dash.cloudflare.com/${ACCOUNT}/billing`, notifications: `https://dash.cloudflare.com/${ACCOUNT}/notifications` },
    historyPeriodStart: Date.UTC(2026, 8, 1),
    message: null,
    products: [
        {
            basis: "history",
            covered: [],
            description: "Workers Standard Requests",
            id: "workers_requests",
            lastMonth: 20_000_000,
            meter: "requests",
            proposedLimit: 100_000_000,
        },
        {
            basis: "floor",
            covered: [{ enabled: true, limit: "60000000000", managed: true, name: "Lunora Cloud usage alert: d1_rows_read", policyId: "p1" }],
            description: "D1 Rows Read",
            id: "d1_rows_read",
            lastMonth: 0,
            meter: "d1RowsRead",
            proposedLimit: 25_000_000_000,
        },
        {
            basis: "unmapped",
            covered: [{ enabled: true, limit: "9", managed: false, name: "mine", policyId: "own" }],
            description: "Argo Smart Routing",
            id: "argo",
            lastMonth: null,
            meter: null,
            proposedLimit: null,
        },
    ],
    recipients: ["admin@example.com", "owner@example.com"],
    state: "ready",
};

const ENTER_YOURSELF = /enter a threshold yourself/u;
const PAY_AS_YOU_GO = /Pay-as-you-go/u;

const noop = vi.fn<() => Promise<never[]>>(() => Promise.resolve([]));

describe("usage alerts form state", () => {
    it("ticks proposed products not already covered by a policy of the customer's own", () => {
        expect.assertions(1);

        const ownCovered = { ...READY.products[0], covered: [{ enabled: true, limit: "5", managed: false, name: "mine", policyId: "own" }], id: "own_covered" };

        expect(initialSelection([...READY.products, ownCovered] as UsageAlertsOverview["products"])).toStrictEqual(["workers_requests", "d1_rows_read"]);
    });

    it("starts from the managed policy's current threshold, else the proposal", () => {
        expect.assertions(1);

        expect(initialLimits(READY.products)).toStrictEqual({ argo: "", d1_rows_read: "60000000000", workers_requests: "100000000" });
    });

    it("builds the apply request, or says what to fix", () => {
        expect.assertions(5);

        expect(parseRecipients("a@example.com, b@example.com\nc@example.com")).toStrictEqual(["a@example.com", "b@example.com", "c@example.com"]);
        expect(applyRequest(["workers_requests"], { workers_requests: "100,000,000" }, "a@example.com")).toStrictEqual({
            products: [{ id: "workers_requests", limit: 100_000_000 }],
            recipients: ["a@example.com"],
        });
        expect(applyRequest(["argo"], { argo: "" }, "a@example.com")).toStrictEqual({ error: "Enter a whole-number threshold for argo." });
        expect(applyRequest(["workers_requests"], {}, " ")).toStrictEqual({ error: "Add at least one email address to send the alerts to." });
        expect(applyRequest([], {}, "a@example.com")).toStrictEqual({ error: "Choose at least one product." });
    });

    it("explains each proposal, including no history", () => {
        expect.assertions(3);

        expect(describeProposal(READY.products[0] as never)).toBe("3× last month (20,000,000)");
        expect(describeProposal({ basis: "floor", lastMonth: 0 })).toBe("No usage last month — the plan's included amount");
        expect(describeProposal({ basis: "unmapped", lastMonth: null })).toMatch(ENTER_YOURSELF);
    });

    it("summarizes an outcome", () => {
        expect.assertions(1);

        expect(
            summarizeResults([
                { action: "created", kind: null, message: null, productId: "a" },
                { action: "failed", kind: "missing-scope", message: "x", productId: "b" },
            ]),
        ).toBe("Cloudflare alerts: 1 created, 1 failed.");
    });
});

describe(UsageAlertsView, () => {
    it("shows the proposal, the default recipients and the budget alert's dashboard path", () => {
        expect.assertions(8);

        const html = renderToStaticMarkup(<UsageAlertsView onApply={noop} overview={READY} />);

        expect(html).toContain("Workers Standard Requests");
        expect(html).toContain('value="100000000"');
        expect(html).toContain("admin@example.com\nowner@example.com");
        expect(html).toContain("Your policy “mine”");
        expect(html).toContain("Create or update alerts in Cloudflare");
        expect(html).toContain("Cloudflare has no test send");
        expect(html).toContain(`href="https://dash.cloudflare.com/${ACCOUNT}/billing"`);
        expect(html).toContain("Billable Usage → Create budget alert");
    });

    it("offers no setup when Cloudflare names no products, and still points at the dashboard", () => {
        expect.assertions(3);

        const html = renderToStaticMarkup(<UsageAlertsView onApply={noop} overview={{ ...READY, products: [], state: "no-products" }} />);

        expect(html).not.toContain("Create or update alerts in Cloudflare");
        expect(html).toContain("creates none rather than guess");
        expect(html).toContain("Create budget alert");
    });

    it("names the permission to add when the token cannot read notifications, with Cloudflare's own text", () => {
        expect.assertions(4);

        const html = renderToStaticMarkup(
            <UsageAlertsView onApply={noop} overview={{ ...READY, message: "Authentication error", products: [], state: "missing-scope" }} />,
        );

        expect(html).toContain("Notifications: Edit");
        expect(html).toContain("Cloudflare said: Authentication error");
        expect(html).not.toContain("Create or update alerts in Cloudflare");
        expect(STATE_COPY["not-eligible"]).toMatch(PAY_AS_YOU_GO);
    });
});
