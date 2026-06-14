import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Studio } from "../../src/app/studio";
import type { StudioFeaturesResult } from "../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../src/lib/admin";
import type { MockClientHooks } from "../mock-client";
import { createMockClient } from "../mock-client";

const createClient = (features?: Partial<StudioFeaturesResult>): MockClientHooks =>
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

            // Optional-feature flags drive which nav pages render. Default every
            // flag on (the studio's back-compat default) unless a test overrides one.
            if (reference === ADMIN_FUNCTIONS.studioFeatures) {
                return { mail: true, payments: true, scheduler: true, storage: true, vectors: true, ...features };
            }

            // The logs panel mounts when its domain is opened; hand it the real
            // result shape (an `entries` array) rather than the table fallback so
            // it seeds an empty buffer instead of `undefined`.
            if (reference === ADMIN_FUNCTIONS.getLogs || reference === ADMIN_FUNCTIONS.getRequestLog) {
                return { entries: [] };
            }

            return { columns: [], rows: [], total: 0 };
        },
    });

const renderStudio = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <Studio />
    </CirrusProvider>
);

/**
 * Canonical key set of `StudioFeaturesResult`. This hand-mirror lives in
 * `@cirrus/studio` because it can't import `@cirrus/do`; the same tuple and guard
 * live in `@cirrus/do`'s `shard-do.admin.test.ts`. `lint:types` fails here if the
 * studio copy of the type drifts from this tuple — keeping both packages' copies
 * of the wire contract in lockstep.
 */
const STUDIO_FEATURE_KEYS = ["mail", "payments", "scheduler", "storage", "vectors"] as const;

/** `true` only when `Keys` and `Canonical` are mutually assignable (the exact same key set). */
type KeysMatch<Keys extends string, Canonical extends string> = [Keys] extends [Canonical] ? ([Canonical] extends [Keys] ? true : never) : never;

// Compile-time drift guard: assigning `true` fails tsc the moment the key sets diverge.
const STUDIO_FEATURES_KEY_GUARD: KeysMatch<keyof StudioFeaturesResult, (typeof STUDIO_FEATURE_KEYS)[number]> = true;

describe("studio", () => {
    it("shows a rail entry per domain and the active domain's sub-pages", async () => {
        expect.assertions(12);

        render(renderStudio(createClient()));

        // The two-zone shell renders inside the router's root route (resolved a
        // tick after mount), so await the rail before the synchronous queries.
        for (const group of ["home", "database", "functions", "auth", "storage", "reports", "advisors", "logs", "settings"]) {
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

    it("hides a domain's rail entry when its optional package is disabled", async () => {
        expect.assertions(2);

        render(renderStudio(createClient({ storage: false })));

        // Home is package-independent, so its rail entry is always present — await
        // it first so the async feature fetch has resolved before we assert absence.
        await screen.findByTestId("dash-rail-home");

        await waitFor(() => {
            expect(screen.queryByTestId("dash-rail-storage")).toBeNull();
        });

        // A domain whose feature stays enabled is untouched.
        expect(screen.getByTestId("dash-rail-database")).toBeDefined();
    });

    it("hides a single sub-page when its feature is disabled but keeps the domain's other pages", async () => {
        expect.assertions(2);

        // payments lives in the "logs" domain alongside logs/audit/schedule — disabling
        // it should drop only the payments sub-page, not the whole domain.
        render(renderStudio(createClient({ payments: false })));

        fireEvent.click(await screen.findByTestId("dash-rail-logs"));

        // The domain's other sub-pages still render.
        await screen.findByTestId("dash-tab-logs");

        await waitFor(() => {
            expect(screen.queryByTestId("dash-tab-payments")).toBeNull();
        });

        expect(screen.getByTestId("dash-tab-logs")).toBeDefined();
    });

    it("wires the secondary nav as an ARIA tablist and rolls focus with arrow keys", async () => {
        expect.assertions(5);

        render(renderStudio(createClient()));

        // Open a domain with several sub-pages (logs owns logs/audit/schedule/realtime).
        fireEvent.click(await screen.findByTestId("dash-rail-logs"));

        const logsTab = await screen.findByTestId("dash-tab-logs");
        const auditTab = screen.getByTestId("dash-tab-audit");

        // The active tab controls the panel, which is labelled back by that tab.
        expect(logsTab.getAttribute("aria-controls")).toBe("dash-panel");
        expect(screen.getByTestId("dash-panel").getAttribute("aria-labelledby")).toBe("dash-tab-logs");

        // Roving tabindex: only the selected tab sits in the tab order.
        expect(logsTab.tabIndex).toBe(0);
        expect(auditTab.tabIndex).toBe(-1);

        // ArrowDown from the focused tab moves focus to the next one (without navigating).
        logsTab.focus();
        fireEvent.keyDown(logsTab, { key: "ArrowDown" });

        // eslint-disable-next-line testing-library/no-node-access -- no jest-dom toHaveFocus matcher is configured; activeElement is the only way to assert the roving-tabindex focus move.
        expect(document.activeElement).toBe(auditTab);
    });

    it("keeps the studio's StudioFeaturesResult mirror in lockstep with @cirrus/do's contract", () => {
        expect.assertions(2);

        // The compile-time guard (STUDIO_FEATURES_KEY_GUARD) fails the build on drift;
        // this asserts the canonical tuple at runtime so the guard can't be silently deleted.
        expect(STUDIO_FEATURES_KEY_GUARD).toBe(true);
        expect([...STUDIO_FEATURE_KEYS]).toStrictEqual(["mail", "payments", "scheduler", "storage", "vectors"]);
    });
});
