import type { GlobalTablePage } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin";
import { TableEditor } from "../src/table-editor";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const SHARD_TABLES = [{ name: "messages", rowCount: 3 }];
const GLOBAL_TABLES = [{ name: "organizations", rowCount: 2 }];

/** A client that serves both a shard `messages` table and a global `organizations` table. */
const createEditorClient = (): MockClientHooks =>
    createMockClient({
        listGlobalTables: () => GLOBAL_TABLES,
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return SHARD_TABLES;
            }

            return { columns: ["__id__"], rows: [], total: 0 };
        },
        readGlobalTablePage: (): GlobalTablePage => {
            return { columns: ["_id"], rows: [], total: 0 };
        },
    });

/** The minimal router surface the tests touch — keeps clear of TanStack's deep generics. */
interface TestRouter {
    history: { back: () => void };
    navigate: (options: { search: Record<string, unknown>; to: string }) => Promise<void>;
    state: { location: { search: Record<string, unknown> } };
}

/**
 * `TableEditor` lives at the `/data` route and reads its tier + open table from the
 * URL search params, so the tests mount it under a real (in-memory) TanStack router.
 * The returned `router` lets a test assert the URL and drive browser back/forward.
 */
const renderEditor = (mock: MockClientHooks, initialUrl = "/data"): { router: TestRouter; ui: ReactElement } => {
    const rootRoute = createRootRoute();
    const dataRoute = createRoute({ component: () => <TableEditor />, getParentRoute: () => rootRoute, path: "/data" });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: [initialUrl] }), routeTree: rootRoute.addChildren([dataRoute]) });

    return {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TanStack's deeply-generic router type isn't structurally comparable to the minimal TestRouter surface, so the double cast is required (and not redundant, despite the heuristic).
        router: router as unknown as TestRouter,
        ui: (
            <CirrusProvider client={mock.asClient}>
                <RouterProvider router={router} />
            </CirrusProvider>
        ),
    };
};

/** The `?table` search param the router currently holds. */
const tableParam = (router: TestRouter): unknown => router.state.location.search["table"];

/** The `?schema` search param the router currently holds. */
const schemaParam = (router: TestRouter): unknown => router.state.location.search["schema"];

describe("tableEditor", () => {
    it("browses the shard tier by default", async () => {
        expect.assertions(2);

        render(renderEditor(createEditorClient()).ui);

        await screen.findByTestId("cirrus-data-browser");

        expect(screen.getByTestId<HTMLSelectElement>("table-editor-schema").value).toBe("shard");
        expect(screen.getByTestId("db-table-messages")).toBeDefined();
    });

    it("switches to the global D1 tier from the schema selector and records it in the URL", async () => {
        expect.assertions(3);

        const { router, ui } = renderEditor(createEditorClient());

        render(ui);

        await screen.findByTestId("cirrus-data-browser");

        fireEvent.change(screen.getByTestId("table-editor-schema"), { target: { value: "global" } });

        // The global browser replaces the shard one, and the tier is in the URL.
        await screen.findByTestId("cirrus-global-data-browser");

        expect(screen.queryByTestId("cirrus-data-browser")).toBeNull();
        expect(screen.getByTestId("gdb-table-organizations")).toBeDefined();
        expect(schemaParam(router)).toBe("global");
    });

    it("mirrors the open table to the URL and restores it on browser back", async () => {
        expect.assertions(3);

        const { router, ui } = renderEditor(createEditorClient());

        render(ui);

        // Open `messages` from the sidebar — the selection is pushed to the URL.
        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await waitFor(() => {
            if (tableParam(router) !== "messages") {
                throw new Error("table not yet reflected in the URL");
            }
        });

        expect(tableParam(router)).toBe("messages");

        // A deep link with no table, then back, should land back on `messages`.
        await router.navigate({ search: {}, to: "/data" });

        await waitFor(() => {
            if (tableParam(router) !== undefined) {
                throw new Error("table not yet cleared");
            }
        });

        expect(tableParam(router)).toBeUndefined();

        router.history.back();

        await waitFor(() => {
            if (tableParam(router) !== "messages") {
                throw new Error("back did not restore the table");
            }
        });

        expect(tableParam(router)).toBe("messages");
    });

    it("opens the table named in a deep-linked URL on first load", async () => {
        expect.assertions(1);

        render(renderEditor(createEditorClient(), "/data?table=messages").ui);

        // The shard browser auto-selects `messages` from the URL — its page loads
        // without a click (the empty-rows state proves the table was opened).
        await screen.findByTestId("db-page");

        expect(screen.getByTestId("db-page")).toBeDefined();
    });

    it("keeps the global-tier selection and page in sync on browser back", async () => {
        expect.assertions(3);

        // Two global tables with distinguishable rows, so we can tell which one is shown.
        const mock = createMockClient({
            listGlobalTables: () => [
                { name: "organizations", rowCount: 1 },
                { name: "plans", rowCount: 1 },
            ],
            query: (reference): unknown => (reference === ADMIN_FUNCTIONS.listTables ? [] : { columns: [], rows: [], total: 0 }),
            readGlobalTablePage: (options): GlobalTablePage =>
                options.table === "plans"
                    ? { columns: ["_id", "name"], rows: [{ _id: "p1", name: "ProPlan" }], total: 1 }
                    : { columns: ["_id", "name"], rows: [{ _id: "o1", name: "AcmeOrg" }], total: 1 },
        });

        const { router, ui } = renderEditor(mock, "/data?schema=global");

        render(ui);

        // Open organizations, then plans — each pushes a history entry.
        fireEvent.click(await screen.findByTestId("gdb-table-organizations"));
        await waitFor(() => {
            if (!screen.getByTestId("gdb-page").textContent?.includes("AcmeOrg")) {
                throw new Error("organizations page not loaded");
            }
        });

        fireEvent.click(screen.getByTestId("gdb-table-plans"));
        await waitFor(() => {
            if (!screen.getByTestId("gdb-page").textContent?.includes("ProPlan")) {
                throw new Error("plans page not loaded");
            }
        });

        // Back must reload organizations AND move the selection back to it — not just
        // swap the page while the sidebar stays highlighted on `plans` (the H1 bug).
        router.history.back();

        await waitFor(() => {
            if (!screen.getByTestId("gdb-page").textContent?.includes("AcmeOrg")) {
                throw new Error("back did not reload organizations");
            }
        });

        expect(screen.getByTestId("gdb-page").textContent).toContain("AcmeOrg");
        expect(screen.getByTestId("gdb-table-organizations").getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByTestId("gdb-table-plans").getAttribute("aria-pressed")).toBe("false");
    });

    /**
     * A shard `messages` table whose `channel` cell is a `v.id` ref into the global
     * `channels` table. Clicking the ref must NOT read `channels` from the shard
     * (which 404s — global tables live in D1); it must switch to the global tier and
     * open `channels` there.
     */
    const createCrossTierClient = (): MockClientHooks =>
        createMockClient({
            listGlobalTables: () => [{ name: "channels", rowCount: 1 }],
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "messages", rowCount: 1 }];
                }

                // Any shard readTablePage: the messages page with a ref into `channels`.
                return { columns: ["id", "channel"], refs: { channel: "channels" }, rows: [{ channel: "c1", id: "m1" }], total: 1 };
            },
            readGlobalTablePage: (): GlobalTablePage => {
                return { columns: ["_id", "name"], rows: [{ _id: "c1", name: "general" }], total: 1 };
            },
        });

    it("follows a v.id ref into a global table by switching to the global tier", async () => {
        expect.assertions(3);

        const { router, ui } = renderEditor(createCrossTierClient());

        render(ui);

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-rows");

        // The channel cell is a cross-tier ref link.
        const refLink = await screen.findByTestId("db-ref-channel");

        expect(refLink.textContent).toContain("c1");

        // Clicking it lands on the global tier with `channels` open — not a shard 404.
        fireEvent.click(refLink);

        await waitFor(() => {
            if (screen.queryByTestId("gdb-page") === null) {
                throw new Error("did not switch to the global channels table yet");
            }
        });

        expect(screen.getByTestId("gdb-page").textContent).toContain("general");
        expect(schemaParam(router)).toBe("global");
    });
});
