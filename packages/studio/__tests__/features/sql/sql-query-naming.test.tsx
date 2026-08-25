import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SqlEditorPanel } from "../../../src/features/sql/sql-editor-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const QUERY_KEY = "lunora-studio-sql-queries";
const SAVED = [{ id: "q1", name: "Untitled query", sql: "SELECT * FROM messages ORDER BY _creationTime DESC LIMIT 50" }];

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <SqlEditorPanel />
    </LunoraProvider>
);

/** A deployment whose assistant can run, and which drafts one fixed name. */
const namingMock = (available: boolean): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                return { available, level: available ? "schema" : "disabled" };
            }

            if (reference === ADMIN_FUNCTIONS.aiNameQuery) {
                return { result: { degraded: false, description: "The 50 newest rows in messages.", title: "Recent messages" } };
            }

            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 0 }];
            }

            return { columns: [], rowCount: 0, rows: [], truncated: false };
        },
    });

describe("saved-query naming", () => {
    afterEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    it("drafts a title and description, and applies NEITHER until Save", async () => {
        expect.assertions(3);

        localStorage.setItem(QUERY_KEY, JSON.stringify(SAVED));
        render(renderPanel(namingMock(true)));

        fireEvent.click(await screen.findByTestId("sql-query-rename-open-q1"));
        fireEvent.click(await screen.findByTestId("sql-query-suggest-name"));

        const name = await screen.findByTestId<HTMLInputElement>("sql-query-name");
        const description = screen.getByTestId<HTMLInputElement>("sql-query-description");

        expect(name.value).toBe("Recent messages");
        expect(description.value).toBe("The 50 newest rows in messages.");
        // The row still carries the old name: a drafted label is a default, not a rename.
        expect(JSON.parse(localStorage.getItem(QUERY_KEY) ?? "[]")[0].name).toBe("Untitled query");
    });

    it("persists the accepted name and description on Save", async () => {
        expect.assertions(2);

        localStorage.setItem(QUERY_KEY, JSON.stringify(SAVED));
        render(renderPanel(namingMock(true)));

        fireEvent.click(await screen.findByTestId("sql-query-rename-open-q1"));
        fireEvent.click(await screen.findByTestId("sql-query-suggest-name"));
        await screen.findByTestId("sql-query-name");
        fireEvent.click(screen.getByTestId("sql-query-rename-save"));

        const stored = JSON.parse(localStorage.getItem(QUERY_KEY) ?? "[]")[0];

        expect(stored.name).toBe("Recent messages");
        expect(stored.description).toBe("The 50 newest rows in messages.");
    });

    it("hides the suggestion, but not the rename, when the assistant cannot run here", async () => {
        expect.assertions(2);

        localStorage.setItem(QUERY_KEY, JSON.stringify(SAVED));
        render(renderPanel(namingMock(false)));

        fireEvent.click(await screen.findByTestId("sql-query-rename-open-q1"));

        await expect(screen.findByTestId("sql-query-name")).resolves.toBeDefined();

        expect(screen.queryByTestId("sql-query-suggest-name")).toBeNull();
    });
});
