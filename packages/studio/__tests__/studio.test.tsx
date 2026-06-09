import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin";
import { Studio } from "../src/studio";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const createClient = (): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 1 }];
            }

            if (reference === ADMIN_FUNCTIONS.migrationStatus) {
                return { migrations: [] };
            }

            if (reference === ADMIN_FUNCTIONS.getSecurityAudit) {
                return { findings: [] };
            }

            if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                return { functions: [], sinceMs: 0 };
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
    it("shows a rail entry per domain and the active domain's sub-pages", async () => {
        expect.assertions(13);

        render(renderStudio(createClient()));

        // The two-zone shell renders inside the router's root route (resolved a
        // tick after mount), so await the rail before the synchronous queries.
        for (const group of ["home", "tableEditor", "sql", "database", "auth", "storage", "reports", "advisors", "logs", "settings"]) {
            // eslint-disable-next-line no-await-in-loop -- after the first resolves the rest are already present.
            await expect(screen.findByTestId(`dash-rail-${group}`)).resolves.toBeDefined();
        }

        // The default domain (home) lists its sub-page in the secondary nav;
        // sub-pages in other domains aren't rendered until their rail entry is selected.
        expect(screen.getByTestId("dash-tab-home")).toBeDefined();
        expect(screen.queryByTestId("dash-tab-data")).toBeNull();
        expect(screen.queryByTestId("dash-tab-schedule")).toBeNull();
    });

    it("renders the schedule panel via the client when its domain + sub-page are selected", async () => {
        expect.assertions(1);

        render(renderStudio(createClient()));

        // schedule lives in the "logs" domain — open the rail entry, then the sub-page.
        fireEvent.click(await screen.findByTestId("dash-rail-logs"));
        fireEvent.click(await screen.findByTestId("dash-tab-schedule"));

        const scheduledJobs = await screen.findByTestId("cirrus-scheduled-jobs");

        expect(scheduledJobs).toBeDefined();
    });

    it("renders the Security Advisor when the Advisors domain + Security sub-page are selected", async () => {
        expect.assertions(1);

        render(renderStudio(createClient()));

        fireEvent.click(await screen.findByTestId("dash-rail-advisors"));
        fireEvent.click(await screen.findByTestId("dash-tab-security"));

        await expect(screen.findByTestId("cirrus-security-advisor")).resolves.toBeDefined();
    });

    it("switches the active panel when a sub-page is clicked", async () => {
        expect.assertions(1);

        render(renderStudio(createClient()));

        fireEvent.click(await screen.findByTestId("dash-rail-database"));
        fireEvent.click(await screen.findByTestId("dash-tab-migrations"));

        await screen.findByTestId("cirrus-migrations");

        expect(screen.queryByTestId("cirrus-home")).toBeNull();
    });

    it("collapses and re-expands the secondary nav from the rail toggle", async () => {
        expect.assertions(2);

        render(renderStudio(createClient()));

        const toggle = await screen.findByTestId("dash-rail-toggle");
        const secondaryNav = screen.getByTestId("dash-tabs");

        fireEvent.click(toggle);

        expect(secondaryNav.hasAttribute("hidden")).toBe(true);

        fireEvent.click(toggle);

        expect(secondaryNav.hasAttribute("hidden")).toBe(false);
    });
});
