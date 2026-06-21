import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Studio } from "../../src/app/studio";
import { ADMIN_FUNCTIONS } from "../../src/lib/admin";
import { createMockClient } from "../mock-client";

const mock = createMockClient({
    query: (reference): unknown => {
        if (reference === ADMIN_FUNCTIONS.listTables) {
            return [{ name: "verification", rowCount: 1 }];
        }
        if (reference === ADMIN_FUNCTIONS.studioFeatures) {
            return { mail: true, payments: true, scheduler: true, storage: true, vectors: true, workflows: true };
        }
        return { columns: [], rows: [], total: 0 };
    },
});

const renderStudio = () =>
    render(
        <LunoraProvider client={mock.asClient}>
            <Studio />
        </LunoraProvider>,
    );

/**
 * Regression for the data browser trapping the user on the data tab. When the URL
 * carried a `?table=` (or any view param), the browser's URL-mirroring callbacks —
 * fired from a deferred reconcile microtask and the load effect — would
 * `navigate({ to: "/data" })` just after a tab click, cancelling it. The mirrors
 * are now skipped when redundant or once the route has left `/data`.
 */
describe("nav with a search param in the URL", () => {
    afterEach(() => {
        globalThis.history.pushState({}, "", "/");
    });

    it("baseline: switches tabs with no search param", async () => {
        expect.hasAssertions();

        globalThis.history.pushState({}, "", "/data");
        renderStudio();
        await waitFor(() => {
            expect(globalThis.location.pathname).toBe("/data");
        });
        fireEvent.click(await screen.findByTestId("dash-tab-schema"));
        await waitFor(() => {
            expect(globalThis.location.pathname).toBe("/schema");
        });
    });

    it("switches to a sibling tab when ?table= is set", async () => {
        expect.hasAssertions();

        globalThis.history.pushState({}, "", "/data?table=verification");
        renderStudio();
        await waitFor(() => {
            expect(globalThis.location.pathname).toBe("/data");
        });
        fireEvent.click(await screen.findByTestId("dash-tab-schema"));
        await waitFor(() => {
            expect(globalThis.location.pathname).toBe("/schema");
        });
    });

    it("jumps to another domain's page when ?table= is set", async () => {
        expect.hasAssertions();

        globalThis.history.pushState({}, "", "/data?table=verification");
        renderStudio();
        await waitFor(() => {
            expect(globalThis.location.pathname).toBe("/data");
        });
        // Every page is directly reachable from the grouped sidebar.
        fireEvent.click(await screen.findByTestId("dash-tab-logs"));
        await waitFor(() => {
            expect(globalThis.location.pathname).toBe("/logs");
        });
    });

    it("switches tabs when ?filters= is set", async () => {
        expect.hasAssertions();

        globalThis.history.pushState({}, "", `/data?table=verification&filters=${encodeURIComponent('[{"column":"id","operator":"eq","value":"1"}]')}`);
        renderStudio();
        await waitFor(() => {
            expect(globalThis.location.pathname).toBe("/data");
        });
        fireEvent.click(await screen.findByTestId("dash-tab-sql"));
        await waitFor(() => {
            expect(globalThis.location.pathname).toBe("/sql");
        });
    });
});
