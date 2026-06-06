import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { SchemaViewer } from "../src/schema-viewer.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

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

            throw new Error(`unexpected ${reference}`);
        },
        readGlobalTablePage: ({ table }) => {
            return { columns: table === "user" ? ["_id", "email"] : ["_id", "token"], rows: [], total: 0 };
        },
    });

const renderViewer = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <SchemaViewer />
    </CirrusProvider>
);

describe("schemaViewer", () => {
    it("lists tables with counts on mount", async () => {
        expect.assertions(1);

        render(renderViewer(createClient()));

        await screen.findByTestId("sc-table-messages");

        expect(screen.getByTestId("sc-toggle-messages").textContent).toBe("messages (3)");
    });

    it("lazily loads columns when a table is expanded", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderViewer(mock));

        fireEvent.click(await screen.findByTestId("sc-toggle-messages"));

        const columns = await screen.findByTestId("sc-columns-messages");

        expect(columns.textContent).toContain("text");

        // Collapsing then re-expanding must not refetch — columns are memoised.
        fireEvent.click(screen.getByTestId("sc-toggle-messages"));
        fireEvent.click(screen.getByTestId("sc-toggle-messages"));

        const pageCalls = mock.query.mock.calls.filter((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.readTablePage);

        expect(pageCalls).toHaveLength(1);
    });

    it("lists global (D1) tables in their own tier-labelled section", async () => {
        expect.assertions(2);

        render(renderViewer(createClient()));

        await screen.findByTestId("sc-global-table-user");

        expect(screen.getByTestId("sc-global-toggle-user").textContent).toBe("user (5)");
        // The global section is tier-tagged so the operator can tell D1 from shard.
        expect(screen.getByTestId("storage-tier-global")).toBeDefined();
    });

    it("lazily probes a global table's columns on expand", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderViewer(mock));

        fireEvent.click(await screen.findByTestId("sc-global-toggle-session"));

        const columns = await screen.findByTestId("sc-global-columns-session");

        expect(columns.textContent).toContain("token");

        // Collapse + re-expand must not refetch.
        fireEvent.click(screen.getByTestId("sc-global-toggle-session"));
        fireEvent.click(screen.getByTestId("sc-global-toggle-session"));

        expect(mock.readGlobalTablePage).toHaveBeenCalledTimes(1);
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

        // Shard tables render regardless of the global failure.
        await screen.findByTestId("sc-table-messages");

        expect(screen.getByTestId("sc-toggle-messages").textContent).toBe("messages (3)");
        expect(screen.getByTestId("sc-global-error").textContent).toContain("no D1 binding");
    });
});
