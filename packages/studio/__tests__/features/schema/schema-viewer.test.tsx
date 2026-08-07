import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SchemaViewer } from "../../../src/features/schema/schema-viewer";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

// The viewer mounts the editor overlay when `schemaEditable` is set, and the
// overlay calls `useNavigate()` for the destructive-edit handoff. Only one
// test below sets `schemaEditable`; the mock is harmless for the rest (they
// never reach the overlay) and keeps the synchronous `render()` + `getByTestId`
// pattern working without a `RouterProvider`.
vi.mock(import("@tanstack/react-router"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/react-router")>();

    return {
        ...actual,
        useNavigate: (): (() => Promise<void>) => () => Promise.resolve(),
    };
});

const TABLES = [
    { name: "messages", rowCount: 3 },
    { name: "users", rowCount: 1 },
];

const GLOBAL_TABLES = [
    { name: "user", rowCount: 5 },
    { name: "session", rowCount: 9 },
];

const createClient = (): MockClientHooks =>
    createMockClient({
        listGlobalTables: () => GLOBAL_TABLES,
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return TABLES;
            }

            if (reference === ADMIN_FUNCTIONS.readTablePage) {
                const { table } = args as { table: string };

                return { columns: table === "messages" ? ["__id__", "text"] : ["__id__", "name"], rows: [], total: 0 };
            }

            if (reference === ADMIN_FUNCTIONS.listTableIndexes) {
                const { table } = args as { table: string };

                return { indexes: table === "messages" ? [{ fields: ["author"], name: "by_author", type: "index", unique: true }] : [] };
            }

            if (reference === ADMIN_FUNCTIONS.describeTables) {
                return { columnsByTable: {} };
            }

            throw new Error(`unexpected ${reference}`);
        },
        readGlobalTablePage: ({ table }) =>
            // `session.userId → user` recovered from PRAGMA foreign keys; `user` is the
            // referenced external table (PK column `id`, no FKs of its own).
            table === "user"
                ? { columns: ["id", "email"], rows: [], total: 0 }
                : { columns: ["id", "token", "userId"], refs: { userId: "user" }, rows: [], total: 0 },
    });

const renderViewer = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <SchemaViewer />
    </LunoraProvider>
);

describe("schemaViewer", () => {
    it("renders the authoring overlay only when schemaEditable is set", async () => {
        expect.assertions(3);

        render(
            <LunoraProvider client={createClient().asClient}>
                <SchemaViewer schemaEditable />
            </LunoraProvider>,
        );
        fireEvent.click(screen.getByTestId("sc-view-list"));

        await screen.findByTestId("sc-table-messages");

        // The overlay mounts above the read-only diagram; the diagram still renders.
        expect(screen.getByTestId("sc-editor")).toBeDefined();
        expect(screen.getByTestId("sc-toggle-messages").textContent).toBe("messages (3)");
        // It carries the add controls (a self-contained smoke check; the overlay's
        // own behaviour is covered in schema-editor-overlay.test.tsx).
        expect(screen.getByTestId("sc-editor-add-table")).toBeDefined();
    });

    it("omits the authoring overlay when schemaEditable is unset (read-only)", async () => {
        expect.assertions(1);

        render(renderViewer(createClient()));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        await screen.findByTestId("sc-table-messages");

        expect(screen.queryByTestId("sc-editor")).toBeNull();
    });

    it("lists tables with counts on mount", async () => {
        expect.assertions(1);

        render(renderViewer(createClient()));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        await screen.findByTestId("sc-table-messages");

        expect(screen.getByTestId("sc-toggle-messages").textContent).toBe("messages (3)");
    });

    it("lazily loads columns when a table is expanded", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderViewer(mock));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        fireEvent.click(await screen.findByTestId("sc-toggle-messages"));

        const columns = await screen.findByTestId("sc-columns-messages");

        expect(columns.textContent).toContain("text");

        // Collapsing then re-expanding must not refetch — columns are memoised.
        fireEvent.click(screen.getByTestId("sc-toggle-messages"));
        fireEvent.click(screen.getByTestId("sc-toggle-messages"));

        const pageCalls = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.readTablePage);

        expect(pageCalls).toHaveLength(1);
    });

    it("shows declared indexes alongside columns when a table is expanded", async () => {
        expect.assertions(3);

        render(renderViewer(createClient()));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        fireEvent.click(await screen.findByTestId("sc-toggle-messages"));

        const list = await screen.findByTestId("sc-indexes-messages");

        // The unique secondary index on `author` renders name, kind, and fields.
        expect(list.textContent).toContain("by_author");
        expect(list.textContent).toContain("author");
        expect(list.textContent).toContain("unique");
    });

    it("omits the index list for a table with no declared indexes", async () => {
        expect.assertions(1);

        render(renderViewer(createClient()));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        fireEvent.click(await screen.findByTestId("sc-toggle-users"));
        await screen.findByTestId("sc-columns-users");

        // `users` returns an empty index list, so no index sub-list is rendered.
        expect(screen.queryByTestId("sc-indexes-users")).toBeNull();
    });

    it("lists global (D1) tables in their own tier-labelled section", async () => {
        expect.assertions(2);

        render(renderViewer(createClient()));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        await screen.findByTestId("sc-global-table-user");

        expect(screen.getByTestId("sc-global-toggle-user").textContent).toBe("user (5)");
        // The global section is tier-tagged so the operator can tell D1 from shard.
        expect(screen.getByTestId("storage-tier-global")).toBeDefined();
    });

    it("lazily probes a global table's columns on expand", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderViewer(mock));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        fireEvent.click(await screen.findByTestId("sc-global-toggle-session"));

        const columns = await screen.findByTestId("sc-global-columns-session");

        expect(columns.textContent).toContain("token");

        // Collapse + re-expand must not refetch.
        fireEvent.click(screen.getByTestId("sc-global-toggle-session"));
        fireEvent.click(screen.getByTestId("sc-global-toggle-session"));

        expect(mock.readGlobalTablePage).toHaveBeenCalledTimes(1);
    });

    it("filters the table lists by name as the operator types", async () => {
        expect.assertions(2);

        render(renderViewer(createClient()));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        await screen.findByTestId("sc-table-users");

        fireEvent.change(screen.getByTestId("sc-filter"), { target: { value: "mess" } });

        // `messages` matches the filter; `users` is filtered out of the shard list.
        expect(screen.getByTestId("sc-table-messages")).toBeDefined();
        expect(screen.queryByTestId("sc-table-users")).toBeNull();
    });

    it("graphs both tiers on one canvas and filters a tier off in-canvas", async () => {
        expect.assertions(3);

        render(renderViewer(createClient()));

        // Graph is the default view, so no switch is needed — and the node
        // appearing below is itself the signal that the tables loaded.

        // A single canvas holds both a shard node (`messages`) and a global node (`user`).
        await screen.findByTestId("sd-node-messages");

        expect(screen.getByTestId("sd-node-user")).toBeDefined();

        // The in-canvas tier filter drops the global tier's nodes.
        fireEvent.click(screen.getByTestId("sc-graph-tier-global"));

        expect(screen.queryByTestId("sd-node-user")).toBeNull();
        expect(screen.getByTestId("sd-node-messages")).toBeDefined();
    });

    it("marks an external global table's FK column, recovered from PRAGMA foreign keys", async () => {
        expect.assertions(1);

        render(renderViewer(createClient()));

        // Graph is the default view, so no switch is needed — and the node
        // appearing below is itself the signal that the tables loaded.

        // `session.userId` carries a `ref` from `readGlobalTablePage`'s `refs` map
        // (no schema entry), so its node row shows the FK badge → the global→global
        // edge can be drawn.
        const column = await screen.findByTestId("sd-col-session-userId");

        expect(column.textContent).toContain("FK");
    });

    it("still shows shard tables when global discovery fails (D1 not configured)", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            listGlobalTables: () => {
                throw new Error("no D1 binding");
            },
            query: (reference): unknown => (reference === ADMIN_FUNCTIONS.listTables ? TABLES : { columns: [], rows: [], total: 0 }),
        });

        render(renderViewer(mock));
        fireEvent.click(screen.getByTestId("sc-view-list"));

        // Shard tables render regardless of the global failure.
        await screen.findByTestId("sc-table-messages");

        expect(screen.getByTestId("sc-toggle-messages").textContent).toBe("messages (3)");
        expect(screen.getByTestId("sc-global-error").textContent).toContain("no D1 binding");
    });
});
