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

const createClient = (): MockClientHooks =>
    createMockClient({
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
});
