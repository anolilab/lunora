import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { ADMIN_FUNCTIONS, type MigrationStatusRow } from "../src/admin.js";
import { MigrationsPanel } from "../src/migrations.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const ROWS: MigrationStatusRow[] = [
    { changed: 5, cursor: null, direction: "up", error: null, id: "0001_backfill", processed: 10, startedAt: 1, status: "completed", updatedAt: 2 },
];

const createClient = (): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.migrationStatus) {
                return { migrations: ROWS };
            }

            if (reference === ADMIN_FUNCTIONS.runMigration) {
                const { dryRun, id } = args as { dryRun: boolean; id: string };

                return { changed: 0, cursor: null, direction: "up", dryRun, id, processed: 3, status: "completed" };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <MigrationsPanel />
    </CirrusProvider>
);

describe("migrationsPanel", () => {
    test("lists migration status rows on mount", async () => {
        render(renderPanel(createClient()));

        await waitFor(() => {
            expect(screen.getByTestId("mg-row-0001_backfill")).toBeDefined();
        });

        expect(screen.getByTestId("mg-row-0001_backfill").textContent).toContain("completed");
    });

    test("requires an id before running", async () => {
        render(renderPanel(createClient()));

        await waitFor(() => {
            expect(screen.getByTestId("mg-table")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("mg-run"));

        await waitFor(() => {
            expect(screen.getByTestId("mg-run-error").textContent).toBe("Enter a migration id");
        });
    });

    test("runs a migration and reports the result", async () => {
        const mock = createClient();

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("mg-table")).toBeDefined();
        });

        fireEvent.change(screen.getByTestId("mg-id-input"), { target: { value: "0002_rename" } });
        fireEvent.click(screen.getByTestId("mg-dry-run")); // turn dry-run off
        fireEvent.click(screen.getByTestId("mg-run"));

        await waitFor(() => {
            expect(screen.getByTestId("mg-run-result").textContent).toContain("completed");
        });

        const runCall = mock.query.mock.calls.find((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.runMigration);

        expect(runCall?.[1]).toMatchObject({ dryRun: false, id: "0002_rename" });
    });
});
