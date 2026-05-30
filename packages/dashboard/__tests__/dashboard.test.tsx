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
    test("shows every tab by default", () => {
        render(renderDashboard(createClient()));

        for (const tab of ["data", "globals", "schema", "functions", "migrations", "export", "files", "schedule", "users", "metrics"]) {
            expect(screen.getByTestId(`dash-tab-${tab}`)).toBeDefined();
        }
    });

    test("renders the schedule panel via the client when its tab is selected", async () => {
        render(renderDashboard(createClient()));

        fireEvent.click(screen.getByTestId("dash-tab-schedule"));

        await waitFor(() => {
            expect(screen.getByTestId("cirrus-scheduled-jobs")).toBeDefined();
        });
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
