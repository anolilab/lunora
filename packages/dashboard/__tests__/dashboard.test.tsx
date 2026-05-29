import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { Dashboard } from "../src/dashboard.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const createClient = (): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 1 }];
            }

            if (reference === ADMIN_FUNCTIONS.migrationStatus) {
                return { migrations: [] };
            }

            return { columns: [], rows: [], total: 0 };
        },
    });

const renderDashboard = (mock: MockClientHooks, props = {}) => (
    <CirrusProvider client={mock.asClient}>
        <Dashboard {...props} />
    </CirrusProvider>
);

describe("dashboard", () => {
    test("shows data + schema tabs by default and hides function/schedule tabs", () => {
        render(renderDashboard(createClient()));

        expect(screen.getByTestId("dash-tab-data")).toBeDefined();
        expect(screen.getByTestId("dash-tab-schema")).toBeDefined();
        expect(screen.getByTestId("dash-tab-migrations")).toBeDefined();
        expect(screen.getByTestId("dash-tab-export")).toBeDefined();
        expect(screen.queryByTestId("dash-tab-functions")).toBeNull();
        expect(screen.queryByTestId("dash-tab-schedule")).toBeNull();
    });

    test("reveals the function tab when functions are supplied", () => {
        render(renderDashboard(createClient(), { functions: [{ kind: "query", path: "messages:list" }] }));

        expect(screen.getByTestId("dash-tab-functions")).toBeDefined();
    });

    test("reveals the schedule tab when a loader is supplied", () => {
        render(renderDashboard(createClient(), { scheduledLoad: async () => [] }));

        expect(screen.getByTestId("dash-tab-schedule")).toBeDefined();
    });

    test("switches the active panel when a tab is clicked", async () => {
        render(renderDashboard(createClient()));

        fireEvent.click(screen.getByTestId("dash-tab-migrations"));

        await waitFor(() => {
            expect(screen.getByTestId("cirrus-migrations")).toBeDefined();
        });

        expect(screen.queryByTestId("cirrus-data-browser")).toBeNull();
    });
});
