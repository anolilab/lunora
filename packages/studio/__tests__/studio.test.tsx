import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { Studio } from "../src/studio.js";
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

const renderStudio = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <Studio />
    </CirrusProvider>
);

describe("studio", () => {
    it("shows a rail entry per area and the active area's tabs", async () => {
        expect.assertions(9);

        render(renderStudio(createClient()));

        // The two-zone shell renders inside the router's root route (resolved a
        // tick after mount), so await the rail before the synchronous queries.
        for (const group of ["database", "logic", "storage", "auth", "observability", "deployment"]) {
            // eslint-disable-next-line no-await-in-loop -- after the first resolves the rest are already present.
            expect(await screen.findByTestId(`dash-rail-${group}`)).toBeDefined();
        }

        // The default area (database) lists its tabs in the secondary nav; tabs
        // in other areas aren't rendered until that rail entry is selected.
        expect(screen.getByTestId("dash-tab-data")).toBeDefined();
        expect(screen.getByTestId("dash-tab-schema")).toBeDefined();
        expect(screen.queryByTestId("dash-tab-schedule")).toBeNull();
    });

    it("renders the schedule panel via the client when its area + tab are selected", async () => {
        expect.assertions(1);

        render(renderStudio(createClient()));

        // schedule lives in the "logic" area — open the rail entry, then the tab.
        fireEvent.click(await screen.findByTestId("dash-rail-logic"));
        fireEvent.click(await screen.findByTestId("dash-tab-schedule"));

        const scheduledJobs = await screen.findByTestId("cirrus-scheduled-jobs");

        expect(scheduledJobs).toBeDefined();
    });

    it("switches the active panel when a tab is clicked", async () => {
        expect.assertions(1);

        render(renderStudio(createClient()));

        fireEvent.click(await screen.findByTestId("dash-rail-logic"));
        fireEvent.click(await screen.findByTestId("dash-tab-migrations"));

        await screen.findByTestId("cirrus-migrations");

        expect(screen.queryByTestId("cirrus-data-browser")).toBeNull();
    });
});
