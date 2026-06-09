import { CirrusProvider } from "@cirrus/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LogEntry, RequestLogEntry } from "../src/admin";
import { ADMIN_FUNCTIONS } from "../src/admin";
import { LogsPanel } from "../src/logs-panel";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const WINDOWED_ENTRY = /entry-\d+/;

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

const REQUESTS: RequestLogEntry[] = [
    {
        durationMs: 4,
        functionPath: "messages:send",
        outcome: "error",
        errorMessage: "boom",
        seq: 2,
        shardKey: "room-9",
        subscriptionsReRun: 0,
        tablesRead: [],
        tablesWritten: ["messages"],
        ts: 1_700_000_002_000,
        userId: "u2",
    },
    {
        cacheHit: true,
        durationMs: 1,
        functionPath: "messages:list",
        outcome: "ok",
        seq: 1,
        shardKey: "room-9",
        subscriptionsReRun: 0,
        tablesRead: ["messages"],
        tablesWritten: [],
        ts: 1_700_000_001_000,
        userId: "u1",
    },
];

/** A mock serving both the durable request log and the in-memory error buffer. */
const createClient = (entries: LogEntry[] = ENTRIES, requests: RequestLogEntry[] = REQUESTS): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getRequestLog) {
                return { entries: requests };
            }

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

/** Switch to the in-memory Errors view (the default view is the durable request log). */
const switchToErrors = (): void => {
    fireEvent.click(screen.getByTestId("lg-view-errors"));
};

describe("logsPanel — requests view (default)", () => {
    it("renders one row per durable request log entry on mount", async () => {
        expect.assertions(4);

        render(renderPanel(createClient()));

        await screen.findByTestId("lg-table");

        const rows = screen.getAllByTestId("lg-req-row");

        expect(rows).toHaveLength(2);
        // Newest first: the error precedes the ok.
        expect(rows[0]?.textContent).toContain("messages:send");
        expect(rows[0]?.textContent).toContain("error");
        expect(rows[1]?.textContent).toContain("messages:list");
    });

    it("queries getRequestLog with the correlation filters and re-reads server-side", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("lg-table");

        fireEvent.change(screen.getByTestId("lg-req-path"), { target: { value: "messages:" } });
        fireEvent.change(screen.getByTestId("lg-req-outcome"), { target: { value: "error" } });

        // The Requests view re-reads server-side on each filter change, so the
        // newest `getRequestLog` call must eventually carry the merged filters.
        await waitFor(
            () => {
                const carriesFilters = mock.query.mock.calls.some(
                    (call) =>
                        (call[0] as { __cirrusRef: string }).__cirrusRef === ADMIN_FUNCTIONS.getRequestLog &&
                        (call[1] as Record<string, unknown>).functionPathPrefix === "messages:" &&
                        (call[1] as Record<string, unknown>).outcome === "error",
                );

                if (!carriesFilters) {
                    throw new Error("filters not applied yet");
                }
            },
            { timeout: 3000 },
        );

        const merged = mock.query.mock.calls.find(
            (call) => (call[1] as Record<string, unknown>).functionPathPrefix === "messages:" && (call[1] as Record<string, unknown>).outcome === "error",
        ) as [{ __cirrusRef: string }, Record<string, unknown>, unknown];

        expect(merged[0].__cirrusRef).toBe(ADMIN_FUNCTIONS.getRequestLog);
        expect(merged[1]).toEqual({ functionPathPrefix: "messages:", outcome: "error" });
    });

    it("forwards the shard key on refresh", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("lg-table");

        fireEvent.change(screen.getByTestId("lg-shard-input"), { target: { value: "room-9" } });
        fireEvent.click(screen.getByTestId("lg-refresh"));

        await waitFor(() => {
            const last = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }] | undefined;

            if (last?.[2]?.shardKey !== "room-9") {
                throw new Error("not refreshed yet");
            }
        });

        const lastCall = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }];

        expect(lastCall[2]).toEqual({ shardKey: "room-9" });
    });

    it("links out to Cloudflare Workers Observability for the raw firehose", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        const link = await screen.findByTestId("lg-cf-link");

        expect(link.getAttribute("href")).toContain("observability");
    });

    it("toggling Live subscribes to getRequestLog and renders pushed entries", async () => {
        expect.assertions(2);

        const mock = createClient([], []);

        render(renderPanel(mock));

        await screen.findByTestId("lg-empty");
        fireEvent.click(screen.getByTestId("lg-live"));

        const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __cirrusRef: string } | undefined;

        expect(ref?.__cirrusRef).toBe(ADMIN_FUNCTIONS.getRequestLog);

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getRequestLog, { entries: REQUESTS });
        });

        const rows = await screen.findAllByTestId("lg-req-row");

        expect(rows[0]?.textContent).toContain("messages:send");
    });
});

describe("logsPanel — errors view", () => {
    it("renders a row per captured log after switching to Errors", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        await screen.findByTestId("lg-table");
        switchToErrors();

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("boom");
        expect(rows[0]?.textContent).toContain("messages:send");
    });

    it("shows the empty state when there are no logs", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([], [])));

        switchToErrors();

        const empty = await screen.findByTestId("lg-empty");

        expect(empty.textContent).toBe("No logs.");
    });

    it("surfaces an error", async () => {
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

    it("filters entries by case-insensitive search text", async () => {
        expect.assertions(3);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");
        switchToErrors();
        await screen.findAllByTestId("lg-row");

        fireEvent.change(screen.getByTestId("lg-search"), { target: { value: "BOOM" } });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("boom failed");
        expect(rows[1]?.textContent).toContain("BOOM recovered");
    });

    it("shows the empty state when the search matches nothing", async () => {
        expect.assertions(1);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");
        switchToErrors();
        await screen.findAllByTestId("lg-row");

        fireEvent.change(screen.getByTestId("lg-search"), { target: { value: "no-such-message" } });

        const empty = await screen.findByTestId("lg-empty");

        expect(empty.textContent).toBe("No logs.");
    });

    it("filters entries by level", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");
        switchToErrors();
        await screen.findAllByTestId("lg-row");

        fireEvent.change(screen.getByTestId("lg-level-filter"), { target: { value: "info" } });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.textContent?.includes("info"))).toBe(true);
    });

    it("composes search and level filters", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");
        switchToErrors();
        await screen.findAllByTestId("lg-row");

        fireEvent.change(screen.getByTestId("lg-search"), { target: { value: "boom" } });
        fireEvent.change(screen.getByTestId("lg-level-filter"), { target: { value: "info" } });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.textContent).toContain("BOOM recovered");
    });

    it("virtualizes a large buffer to a bounded number of DOM rows", async () => {
        // The buffer is a bounded 500-entry ring; un-windowed that is 500 <div>s.
        // With a ~400px viewport and ~36px rows the virtualizer should mount only
        // the visible slice (+ overscan) — a small, bounded count well under 500 —
        // which is what proves virtualization is actually windowing the list.
        expect.assertions(3);

        const big: LogEntry[] = Array.from({ length: 500 }, (_, index) => {
            return {
                functionPath: `fn:${String(index)}`,
                level: "error" as const,
                message: `entry-${String(index)}`,
                timestamp: 1_700_000_000_000 + index,
            };
        });

        render(renderPanel(createClient(big)));

        await screen.findByTestId("lg-table");
        switchToErrors();

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(big.length);
        // Every mounted row is a real windowed entry from the buffer (which index
        // window jsdom lands on is irrelevant — that it is a small slice is).
        expect(rows.every((row) => WINDOWED_ENTRY.test(row.textContent ?? ""))).toBe(true);
    });

    it("toggling Live subscribes to getLogs and renders pushed entries", async () => {
        expect.assertions(2);

        const mock = createClient([], []);

        render(renderPanel(mock));

        await screen.findByTestId("lg-empty");
        switchToErrors();
        fireEvent.click(screen.getByTestId("lg-live"));

        const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __cirrusRef: string } | undefined;

        expect(ref?.__cirrusRef).toBe(ADMIN_FUNCTIONS.getLogs);

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getLogs, {
                entries: [{ functionPath: "messages:send", level: "error" as const, message: "live boom", timestamp: 1_700_000_002_000 }],
            });
        });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows[0]?.textContent).toContain("live boom");
    });
});
