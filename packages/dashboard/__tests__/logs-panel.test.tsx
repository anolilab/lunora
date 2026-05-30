import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { ADMIN_FUNCTIONS, type LogEntry } from "../src/admin.js";
import { LogsPanel } from "../src/logs-panel.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const ENTRIES: LogEntry[] = [
    { functionPath: "messages:send", level: "error", message: "boom", timestamp: 1_700_000_002_000 },
    { functionPath: "messages:list", level: "error", message: "kapow", timestamp: 1_700_000_001_000 },
];

const MIXED_ENTRIES: LogEntry[] = [
    { functionPath: "messages:send", level: "error", message: "boom failed", timestamp: 1_700_000_004_000 },
    { functionPath: "messages:list", level: "warn", message: "slow query", timestamp: 1_700_000_003_000 },
    { functionPath: "auth:login", level: "info", message: "BOOM recovered", timestamp: 1_700_000_002_000 },
    { functionPath: "auth:logout", level: "info", message: "ok", timestamp: 1_700_000_001_000 },
];

const createClient = (entries: LogEntry[] = ENTRIES): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getLogs) {
                return { entries };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <LogsPanel />
    </CirrusProvider>
);

describe("logsPanel", () => {
    test("renders a row per captured log on mount", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        await screen.findByTestId("lg-table");

        const rows = screen.getAllByTestId("lg-row");

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("boom");
        expect(rows[0]?.textContent).toContain("messages:send");
    });

    test("shows the empty state when there are no logs", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([])));

        const empty = await screen.findByTestId("lg-empty");

        expect(empty.textContent).toBe("No logs.");
    });

    test("forwards the shard key on refresh", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("lg-table");

        fireEvent.change(screen.getByTestId("lg-shard-input"), { target: { value: "room-9" } });
        fireEvent.click(screen.getByTestId("lg-refresh"));

        await waitFor(() => {
            if (mock.query.mock.calls.length <= 1) {
                throw new Error("not refreshed yet");
            }
        });

        const lastCall = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }];

        expect(lastCall[2]).toEqual({ shardKey: "room-9" });
    });

    test("surfaces an error", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        const error = await screen.findByTestId("lg-error");

        expect(error.textContent).toBe("ADMIN_FORBIDDEN");
    });

    test("filters entries by case-insensitive search text", async () => {
        expect.assertions(3);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");

        fireEvent.change(screen.getByTestId("lg-search"), { target: { value: "BOOM" } });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("boom failed");
        expect(rows[1]?.textContent).toContain("BOOM recovered");
    });

    test("shows the empty state when the search matches nothing", async () => {
        expect.assertions(1);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");

        fireEvent.change(screen.getByTestId("lg-search"), { target: { value: "no-such-message" } });

        const empty = await screen.findByTestId("lg-empty");

        expect(empty.textContent).toBe("No logs.");
    });

    test("filters entries by level", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");

        fireEvent.change(screen.getByTestId("lg-level-filter"), { target: { value: "info" } });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.textContent?.includes("info"))).toBe(true);
    });

    test("composes search and level filters", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");

        fireEvent.change(screen.getByTestId("lg-search"), { target: { value: "boom" } });
        fireEvent.change(screen.getByTestId("lg-level-filter"), { target: { value: "info" } });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.textContent).toContain("BOOM recovered");
    });
});
