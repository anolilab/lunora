import { LunoraProvider } from "@lunora/react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SubscriptionsPanel from "../../../src/features/logs/subscriptions-panel";
import type { SubscriptionsResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const RESULT: SubscriptionsResult = {
    connections: [
        {
            admin: false,
            id: 0,
            subscriptions: [
                { args: { room: "general" }, functionPath: "messages:list", table: "messages" },
                { functionPath: "presence:list", table: "presence" },
            ],
        },
        { admin: true, id: 1, subscriptions: [{ functionPath: "__lunora_admin__:getMetrics" }] },
    ],
    totalConnections: 2,
    totalSubscriptions: 3,
};

const EMPTY: SubscriptionsResult = { connections: [], totalConnections: 0, totalSubscriptions: 0 };

const createClient = (result: SubscriptionsResult = RESULT): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listSubscriptions) {
                return result;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <SubscriptionsPanel />
    </LunoraProvider>
);

describe("subscriptionsPanel", () => {
    it("renders a row per subscription with its connection, function path, table, and args", async () => {
        expect.assertions(5);

        render(renderPanel(createClient()));

        await screen.findByTestId("subs-table");

        const rows = screen.getAllByTestId("subs-row");

        expect(rows).toHaveLength(3);

        const first = within(rows[0] as HTMLElement).getAllByRole("cell");

        expect(first[0]?.textContent).toContain("#0");
        expect(first[1]?.textContent).toBe("messages:list");
        expect(first[2]?.textContent).toBe("messages");
        expect(first[3]?.textContent).toContain("general");
    });

    it("flags the admin socket and renders the aggregate counts", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        const count = await screen.findByTestId("subs-count");

        expect(count.textContent).toContain("2 connections");
        expect(count.textContent).toContain("3 subscriptions");

        // The admin socket (connection #1) carries the `admin` badge.
        const adminRow = screen.getAllByTestId("subs-row").find((row) => row.textContent?.includes("#1"));

        expect(adminRow?.textContent).toContain("admin");
    });

    it("renders a live query whose args hold a bigint instead of crashing the panel", async () => {
        expect.assertions(2);

        // Subscription args are wire-decoded when the socket attaches and handed
        // back verbatim, so a live query on a `v.bigint()` column carries a real
        // bigint here — `JSON.stringify` throws on it, taking the panel down on
        // every poll.
        const withBigint: SubscriptionsResult = {
            connections: [{ admin: false, id: 0, subscriptions: [{ args: { minAmount: 42n }, functionPath: "ledger:since", table: "ledger" }] }],
            totalConnections: 1,
            totalSubscriptions: 1,
        };

        render(renderPanel(createClient(withBigint)));

        await screen.findByTestId("subs-table");

        const cells = within(screen.getAllByTestId("subs-row")[0] as HTMLElement).getAllByRole("cell");

        expect(cells[1]?.textContent).toBe("ledger:since");
        expect(cells[3]?.textContent).toContain("42");
    });

    it("shows the empty state when there are no subscriptions", async () => {
        expect.assertions(1);

        render(renderPanel(createClient(EMPTY)));

        const empty = await screen.findByTestId("subs-empty");

        expect(empty.textContent).toContain("No active subscriptions.");
    });
});
