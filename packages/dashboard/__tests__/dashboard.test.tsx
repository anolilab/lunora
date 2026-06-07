import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { Dashboard } from "../src/dashboard.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

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

const renderDashboard = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <Dashboard />
    </CirrusProvider>
);

describe("dashboard", () => {
    it("shows every tab by default", async () => {
        expect.assertions(12);

        render(renderDashboard(createClient()));

        // The sidebar renders inside the router's root route (resolved a tick
        // after mount), so await each tab rather than querying synchronously.
        for (const tab of ["data", "globals", "schema", "functions", "migrations", "export", "files", "schedule", "users", "metrics", "logs", "settings"]) {
            // eslint-disable-next-line no-await-in-loop -- after the first resolves the rest are already present; awaiting each keeps the assertion shape simple.
            await expect(screen.findByTestId(`dash-tab-${tab}`)).resolves.toBeDefined();
        }
    });

    it("renders the schedule panel via the client when its tab is selected", async () => {
        expect.assertions(1);

        render(renderDashboard(createClient()));

        fireEvent.click(await screen.findByTestId("dash-tab-schedule"));

        const scheduledJobs = await screen.findByTestId("cirrus-scheduled-jobs");

        expect(scheduledJobs).toBeDefined();
    });

    it("switches the active panel when a tab is clicked", async () => {
        expect.assertions(1);

        render(renderDashboard(createClient()));

        fireEvent.click(await screen.findByTestId("dash-tab-migrations"));

        await screen.findByTestId("cirrus-migrations");

        expect(screen.queryByTestId("cirrus-data-browser")).toBeNull();
    });
});
