import { CirrusProvider } from "@cirrus/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
        expect.assertions(1);

        render(renderPanel(createClient()));

        const row = await screen.findByTestId("mg-row-0001_backfill");

        expect(row.textContent).toContain("completed");
    });

    test("requires an id before running", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        await screen.findByTestId("mg-table");

        fireEvent.click(screen.getByTestId("mg-run"));

        const runError = await screen.findByTestId("mg-run-error");

        expect(runError.textContent).toBe("Enter a migration id");
    });

    test("runs a migration and reports the result", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mg-table");

        fireEvent.change(screen.getByTestId("mg-id-input"), { target: { value: "0002_rename" } });
        fireEvent.click(screen.getByTestId("mg-dry-run")); // turn dry-run off
        fireEvent.click(screen.getByTestId("mg-run"));

        await screen.findByTestId("mg-run-result");

        const runCall = mock.query.mock.calls.find((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.runMigration);

        expect(runCall?.[1]).toMatchObject({ dryRun: false, id: "0002_rename" });
    });

    test("toggling Live subscribes to migrationStatus and folds in pushed progress", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mg-table");
        fireEvent.click(screen.getByTestId("mg-live"));

        const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __cirrusRef: string } | undefined;

        expect(ref?.__cirrusRef).toBe(ADMIN_FUNCTIONS.migrationStatus);

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.migrationStatus, {
                migrations: [
                    {
                        changed: 7,
                        cursor: "c1",
                        direction: "up",
                        error: null,
                        id: "0001_backfill",
                        processed: 42,
                        startedAt: 1,
                        status: "in_progress",
                        updatedAt: 9,
                    },
                ],
            });
        });

        expect(screen.getByTestId("mg-row-0001_backfill").textContent).toContain("in_progress");
    });
});
