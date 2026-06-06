import { CirrusProvider } from "@cirrus/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AuditEntry } from "../src/admin.js";
import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { AuditPanel } from "../src/audit-panel.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

const ENTRIES: AuditEntry[] = [
    { detail: { changed: 3, userId: "admin-1" }, id: undefined, op: "runMigration", seq: 2, table: undefined, ts: 1_700_000_002_000 },
    { detail: { op: "patch" }, id: "u1", op: "writeRow", seq: 1, table: "users", ts: 1_700_000_001_000 },
];

const createClient = (entries: AuditEntry[] = ENTRIES): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getAuditLog) {
                return { entries };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <AuditPanel />
    </CirrusProvider>
);

/** Body rows (after the header), newest-first as the panel renders them. */
const bodyRows = (): HTMLElement[] => screen.getAllByTestId("au-row");

describe("auditPanel", () => {
    it("renders a row per recorded entry on mount, newest first", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        await screen.findByTestId("au-table");

        const rows = bodyRows();

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("runMigration");
        expect(rows[1]?.textContent).toContain("writeRow");
    });

    it("renders the table, id, and detail columns for an entry", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        await screen.findByTestId("au-table");

        const writeRow = bodyRows()[1] as HTMLElement;
        const cells = within(writeRow).getAllByRole("cell");

        expect(cells[2]?.textContent).toBe("users");
        expect(cells[3]?.textContent).toBe("u1");
        expect(cells[4]?.textContent).toContain("patch");
    });

    it("shows the empty state when there are no entries", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([])));

        const empty = await screen.findByTestId("au-empty");

        expect(empty.textContent).toBe("No audit entries.");
    });

    it("filters entries by op/table/id substring", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        await screen.findByTestId("au-table");

        fireEvent.change(screen.getByTestId("au-search"), { target: { value: "users" } });

        const rows = await screen.findAllByTestId("au-row");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.textContent).toContain("writeRow");
    });

    it("forwards the shard key on refresh", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("au-table");

        fireEvent.change(screen.getByTestId("au-shard-input"), { target: { value: "room-9" } });
        fireEvent.click(screen.getByTestId("au-refresh"));

        await waitFor(() => {
            if (mock.query.mock.calls.length <= 1) {
                throw new Error("not refreshed yet");
            }
        });

        const lastCall = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }];

        expect(lastCall[2]).toEqual({ shardKey: "room-9" });
    });

    it("surfaces an error", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        const error = await screen.findByTestId("au-error");

        expect(error.textContent).toBe("ADMIN_FORBIDDEN");
    });

    it("toggling Live opens a getAuditLog subscription and renders pushed entries", async () => {
        expect.assertions(3);

        const mock = createClient([]);

        render(renderPanel(mock));

        await screen.findByTestId("au-empty");

        expect(mock.subscribe).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId("au-live"));

        const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __cirrusRef: string } | undefined;

        expect(ref?.__cirrusRef).toBe(ADMIN_FUNCTIONS.getAuditLog);

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getAuditLog, {
                entries: [{ detail: { applied: 2 }, op: "applyCdc", seq: 7, ts: 1_700_000_003_000 }],
            });
        });

        const rows = await screen.findAllByTestId("au-row");

        expect(rows[0]?.textContent).toContain("applyCdc");
    });
});
