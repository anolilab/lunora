import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { permissionLabel } from "../src/client/cloudflare-accounts";
import { UsageAlertsView } from "../src/client/CloudflareUsageAlerts";
import type { UsageAlertProduct, UsageAlertsOverview, UsageAlertsResult } from "../src/client/usage-alerts";
import {
    applyRequest,
    coveredByOwnPolicy,
    describeChanges,
    describeProposal,
    describeStored,
    initialLimits,
    initialSelection,
    limitWarning,
    parseRecipients,
    STATE_COPY,
    summarizeResults,
} from "../src/client/usage-alerts";

/** The connected-account page's Cloudflare usage alerts: what it proposes, and what it says when it cannot. */

const ACCOUNT = "a".repeat(32);

const product = (overrides: Partial<UsageAlertProduct>): UsageAlertProduct => {
    return {
        basis: "history",
        covered: [],
        description: "Workers requests",
        id: "worker_requests",
        lastMonth: 20_000_000,
        proposedLimit: 100_000_000,
        ...overrides,
    };
};

const READY: UsageAlertsOverview = {
    dashboard: { budgetAlert: `https://dash.cloudflare.com/${ACCOUNT}/billing`, notifications: `https://dash.cloudflare.com/${ACCOUNT}/notifications` },
    historyPeriodStart: Date.UTC(2026, 8, 1),
    message: null,
    products: [
        product({}),
        product({
            basis: "no-data",
            covered: [{ enabled: true, limit: "3000000", managed: true, name: "Lunora Cloud usage alert: worker_durable_objects_requests", policyId: "p1" }],
            description: "Durable Objects requests",
            id: "worker_durable_objects_requests",
            lastMonth: null,
            proposedLimit: 1_000_000,
        }),
        product({
            basis: "unmapped",
            covered: [{ enabled: true, limit: "9", managed: false, name: "mine", policyId: "own" }],
            description: "Durable Objects storage reads",
            id: "worker_durable_objects_storage_reads",
            lastMonth: null,
            proposedLimit: null,
        }),
    ],
    productSource: "listed",
    state: "ready",
};

const RESULT: UsageAlertsResult = {
    action: "updated",
    duplicates: 1,
    keptDestinations: 2,
    keptRecipients: ["finance@example.com"],
    kind: null,
    message: null,
    productId: "worker_requests",
    stored: [{ destinations: 2, enabled: false, limit: "100000000", policyId: "p", recipients: ["finance@example.com", "owner@example.com"] }],
};

const ENTER_YOURSELF = /enter a threshold yourself/u;
const NO_DATA = /read back no usage for last month/u;
const PAY_AS_YOU_GO = /Pay-as-you-go/u;
const UNIT = /does not document the unit/u;
const USES_100 = /uses 100/u;

const RECIPIENTS = ["admin@example.com", "owner@example.com"];

const noop = vi.fn<() => Promise<never[]>>(() => Promise.resolve([]));

describe("usage alerts form state", () => {
    it("ticks only data-backed proposals with no enabled policy of the customer's own and no managed policy switched off", () => {
        expect.assertions(1);

        const own = { enabled: true, limit: "5", managed: false, name: "mine", policyId: "own" };
        const products = [
            ...READY.products,
            product({ covered: [own], id: "own_enabled" }),
            product({ covered: [{ ...own, enabled: false }], id: "own_disabled" }),
            product({ covered: [{ ...own, enabled: false, managed: true }], id: "managed_off" }),
            product({ basis: "floor", id: "floor" }),
        ];

        expect(initialSelection(products)).toStrictEqual(["worker_requests", "own_disabled", "floor"]);
    });

    it("counts only an enabled policy of the customer's as covering a product", () => {
        expect.assertions(2);

        expect(coveredByOwnPolicy({ covered: [{ enabled: false, limit: null, managed: false, name: "x", policyId: "x" }] })).toBe(false);
        expect(coveredByOwnPolicy({ covered: [{ enabled: true, limit: null, managed: false, name: "x", policyId: "x" }] })).toBe(true);
    });

    it("starts from the managed policy's current threshold, else the proposal", () => {
        expect.assertions(1);

        expect(initialLimits(READY.products)).toStrictEqual({
            worker_durable_objects_requests: "3000000",
            worker_durable_objects_storage_reads: "",
            worker_requests: "100000000",
        });
    });

    it("builds the apply request with the server's own checks, or says what to fix", () => {
        expect.assertions(6);

        expect(parseRecipients("a@example.com, Jane Doe <jane@example.com>\nc@example.com")).toStrictEqual([
            "a@example.com",
            "Jane Doe <jane@example.com>",
            "c@example.com",
        ]);
        expect(applyRequest(["worker_requests"], { worker_requests: "100,000,000" }, "Jane Doe <Jane@example.com>")).toStrictEqual({
            products: [{ id: "worker_requests", limit: 100_000_000 }],
            recipients: ["jane@example.com"],
        });
        expect(applyRequest(["worker_requests"], { worker_requests: "2000000000000000" }, "a@example.com")).toStrictEqual({
            error: "worker_requests: a threshold must be a whole number from 1 to 1e+15.",
        });
        expect(applyRequest(["worker_requests"], {}, "jane doe")).toStrictEqual({ error: 'Recipients: "jane doe" is not an email address.' });
        expect(applyRequest(["worker_requests"], {}, " ")).toStrictEqual({ error: "Recipients: name 1 to 10 email addresses." });
        expect(applyRequest([], {}, "a@example.com")).toStrictEqual({ error: "Choose at least one product." });
    });

    it("explains each proposal truthfully, including no data", () => {
        expect.assertions(4);

        expect(describeProposal(product({}))).toBe("3× last month (20,000,000)");
        expect(describeProposal({ basis: "floor", lastMonth: 0 })).toBe("Plan's included amount — 3× last month (0) is below it");
        expect(describeProposal({ basis: "no-data", lastMonth: null })).toMatch(NO_DATA);
        expect(describeProposal({ basis: "unmapped", lastMonth: null })).toMatch(ENTER_YOURSELF);
    });

    it("warns when a threshold is orders of magnitude from the customer's own for the product", () => {
        expect.assertions(2);

        const covered = [{ enabled: true, limit: "100", managed: false, name: "mine", policyId: "own" }];

        expect(limitWarning({ covered }, "10,000,000")).toMatch(USES_100);
        expect(limitWarning({ covered }, "500")).toBeNull();
    });

    it("summarizes an outcome, what was kept, and what Cloudflare stored", () => {
        expect.assertions(3);

        expect(summarizeResults([RESULT, { ...RESULT, action: "failed", kind: "missing-scope", productId: "b" }])).toBe(
            "Cloudflare alerts: 1 updated, 1 failed.",
        );
        expect(describeChanges(RESULT)).toStrictEqual([
            "kept addresses already on it: finance@example.com",
            "kept 2 webhook/PagerDuty destination(s)",
            "found and updated 1 duplicate managed policy(ies)",
        ]);
        expect(describeStored(RESULT)).toStrictEqual(["Cloudflare stored: threshold 100000000, disabled, 2 address(es), 2 other destination(s)"]);
    });

    it("labels a recorded notifications permission as read-verified only", () => {
        expect.assertions(1);

        expect(permissionLabel("notifications")).toBe("Notifications: read verified");
    });
});

describe(UsageAlertsView, () => {
    it("shows the proposal, the unit caveat, the coverage gap, the default recipients and the budget alert's dashboard path", () => {
        expect.assertions(9);

        const html = renderToStaticMarkup(<UsageAlertsView onApply={noop} overview={READY} recipients={RECIPIENTS} />);

        expect(html).toContain("Workers requests");
        expect(html).toContain('value="100000000"');
        expect(html).toMatch(UNIT);
        expect(html).toContain("no Usage Based Billing alert for D1 or Workers CPU time");
        expect(html).toContain("admin@example.com\nowner@example.com");
        expect(html).toContain("Your policy “mine”");
        expect(html).toContain("Create or update alerts in Cloudflare");
        expect(html).toContain(`href="https://dash.cloudflare.com/${ACCOUNT}/billing"`);
        expect(html).toContain("Billable Usage → Create budget alert");
    });

    it("says when only the published product ids are offered", () => {
        expect.assertions(1);

        const html = renderToStaticMarkup(<UsageAlertsView onApply={noop} overview={{ ...READY, productSource: "published" }} recipients={RECIPIENTS} />);

        expect(html).toContain("ids Cloudflare publishes");
    });

    it("names the permission to add when the token cannot read notifications, with Cloudflare's own text", () => {
        expect.assertions(4);

        const html = renderToStaticMarkup(
            <UsageAlertsView
                onApply={noop}
                overview={{ ...READY, message: "Authentication error", products: [], state: "missing-scope" }}
                recipients={RECIPIENTS}
            />,
        );

        expect(html).toContain("Notifications: Edit");
        expect(html).toContain("Cloudflare said: Authentication error");
        expect(html).not.toContain("Create or update alerts in Cloudflare");
        expect(STATE_COPY["not-eligible"]).toMatch(PAY_AS_YOU_GO);
    });
});
