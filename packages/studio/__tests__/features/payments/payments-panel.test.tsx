import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { PaymentsPanel } from "../../../src/features/payments/payments-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

type Row = Record<string, unknown>;

const SUBSCRIPTIONS: Row[] = [
    { currentPeriodEnd: 1_700_000_000_000, priceId: "price_pro", provider: "stripe", providerSubscriptionId: "sub_1", referenceId: "user_1", state: "active" },
    { priceId: "price_pro", provider: "stripe", providerSubscriptionId: "sub_2", referenceId: "user_2", state: "past_due" },
];

const EVENTS: Row[] = [
    { processedAt: 1_700_000_001_000, provider: "stripe", providerEventId: "evt_2", type: "subscription.active" },
    { processedAt: 1_700_000_000_000, provider: "stripe", providerEventId: "evt_1", type: "payment.captured" },
];

// Table names the `listTables` presence probe reports — the panel gates its reads
// on `subscriptions` showing up here. `undefined` means "deployment declares no
// payment tables" (the unconfigured case).
const PAYMENT_TABLES = [
    { name: "subscriptions", rowCount: 0 },
    { name: "events", rowCount: 0 },
];

const createClient = (subscriptions: Row[] = SUBSCRIPTIONS, events: Row[] = EVENTS, tables: Row[] | undefined = PAYMENT_TABLES): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return tables;
            }

            if (reference === ADMIN_FUNCTIONS.readTablePage) {
                const { table } = args as { table?: string };

                if (table === "subscriptions") {
                    return { columns: [], rows: subscriptions, total: subscriptions.length };
                }

                if (table === "events") {
                    return { columns: [], rows: events, total: events.length };
                }
            }

            return undefined;
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <PaymentsPanel />
    </LunoraProvider>
);

describe("paymentsPanel", () => {
    it("lists synced subscriptions with their state", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        const rows = await screen.findAllByTestId("payment-subscription-row");

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("active");
    });

    it("lists recent webhook events", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        const events = await screen.findAllByTestId("payment-event-row");

        expect(events).toHaveLength(2);
    });

    it("shows the empty state when there are no subscriptions", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([], [])));

        const empty = await screen.findByTestId("payments-empty");

        expect(empty.dataset["testid"]).toBe("payments-empty");
    });

    it("shows the unconfigured state (not a table error) when the deployment declares no payment tables", async () => {
        expect.assertions(1);

        // A worker predating the `studioFeatures` RPC shows every page; without the
        // store tables the panel must guide the user rather than surface an
        // "unknown table: subscriptions" error.
        render(renderPanel(createClient([], [], [])));

        const unconfigured = await screen.findByTestId("payments-unconfigured");

        expect(unconfigured.dataset["testid"]).toBe("payments-unconfigured");
    });
});
