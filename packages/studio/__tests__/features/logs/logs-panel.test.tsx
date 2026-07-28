import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LogFilterCriteria } from "../../../src/features/logs/logs-panel";
import { filterLogs, LogsPanel, summarizeLogs } from "../../../src/features/logs/logs-panel";
import type { LogEntry, RequestLogEntry } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

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
    <LunoraProvider client={mock.asClient}>
        <LogsPanel />
    </LunoraProvider>
);

/** Switch to the in-memory Errors view (the default view is the durable request log). */
const switchToErrors = (): void => {
    fireEvent.click(screen.getByTestId("lg-view-errors"));
};

describe("logsPanel — requests view (default)", () => {
    it("renders one row per durable request log entry on mount", async () => {
        expect.assertions(4);

        render(renderPanel(createClient()));

        // findBy: rows only render once the async request-log read resolves.
        const rows = await screen.findAllByTestId("lg-req-row");

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
                        (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.getRequestLog &&
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
        ) as [{ __lunoraRef: string }, Record<string, unknown>, unknown];

        expect(merged[0].__lunoraRef).toBe(ADMIN_FUNCTIONS.getRequestLog);
        expect(merged[1]).toEqual({ functionPathPrefix: "messages:", outcome: "error" });
    });

    it("re-seeds on a debounced shard-key change", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("lg-table");

        // No Refresh button: typing a shard re-loads once the value settles.
        fireEvent.change(screen.getByTestId("lg-shard-input"), { target: { value: "room-9" } });

        await waitFor(() => {
            const last = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }] | undefined;

            if (last?.[2]?.shardKey !== "room-9") {
                throw new Error("not re-seeded yet");
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

    it("subscribes to getRequestLog on mount and renders pushed entries", async () => {
        expect.assertions(1);

        const mock = createClient([], []);

        render(renderPanel(mock));

        await screen.findByTestId("lg-empty");

        // No Live toggle: the Requests view subscribes once the mount seed commits a shard.
        await waitFor(() => {
            const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __lunoraRef: string } | undefined;

            if (ref?.__lunoraRef !== ADMIN_FUNCTIONS.getRequestLog) {
                throw new Error("not subscribed yet");
            }
        });

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

    it("renders structured fields and matches them in the search box", async () => {
        expect.assertions(3);

        const withFields: LogEntry[] = [
            { fields: { orderId: "o-42", total: 19 }, functionPath: "orders:place", level: "info", message: "order placed", timestamp: 1_700_000_005_000 },
            { functionPath: "auth:login", level: "info", message: "signed in", timestamp: 1_700_000_004_000 },
        ];

        render(renderPanel(createClient(withFields)));

        await screen.findByTestId("lg-table");
        switchToErrors();

        const fields = await screen.findByTestId("lg-fields");

        expect(fields.textContent).toBe("orderId=o-42 total=19");

        // The field value is searchable via the message search box.
        fireEvent.change(screen.getByTestId("lg-search"), { target: { value: "o-42" } });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.textContent).toContain("order placed");
    });

    it("shows the empty state when there are no logs", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([], [])));

        switchToErrors();

        const empty = await screen.findByTestId("lg-empty");

        expect(empty.textContent).toContain("No logs.");
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

        // `toContain`, not `toBe`: the alert also carries the "Show in console"
        // affordance (plan 204), so an exact-text assertion pins unrelated chrome.
        expect(error.textContent).toContain("ADMIN_FORBIDDEN");
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

        expect(empty.textContent).toContain("No logs.");
    });

    it("filters entries by level", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");
        switchToErrors();
        await screen.findAllByTestId("lg-row");

        fireEvent.click(screen.getByTestId("logs-level-info"));

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
        fireEvent.click(screen.getByTestId("logs-level-info"));

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

    it("subscribes to getLogs in the Errors view and renders pushed entries", async () => {
        expect.assertions(1);

        const mock = createClient([], []);

        render(renderPanel(mock));

        await screen.findByTestId("lg-empty");
        switchToErrors();

        // No Live toggle: switching to the Errors view subscribes to getLogs.
        await waitFor(() => {
            const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __lunoraRef: string } | undefined;

            if (ref?.__lunoraRef !== ADMIN_FUNCTIONS.getLogs) {
                throw new Error("not subscribed yet");
            }
        });

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getLogs, {
                entries: [{ functionPath: "messages:send", level: "error" as const, message: "live boom", timestamp: 1_700_000_002_000 }],
            });
        });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows[0]?.textContent).toContain("live boom");
    });
});

// A fixed "now" so the relative time-range arithmetic in filterLogs is
// deterministic: 1_700_000_004_000 is the newest MIXED_ENTRIES timestamp.
const NOW = 1_700_000_004_000;

/** Build a full filter-criteria object, overriding only the fields a case cares about. */
const criteria = (overrides: Partial<LogFilterCriteria> = {}): LogFilterCriteria => {
    return {
        levels: new Set(),
        now: NOW,
        path: "",
        range: "all",
        search: "",
        ...overrides,
    };
};

describe("filterLogs", () => {
    it("returns every entry when no criteria narrow the set", () => {
        expect.assertions(1);

        expect(filterLogs(MIXED_ENTRIES, criteria())).toHaveLength(MIXED_ENTRIES.length);
    });

    it("keeps only entries whose level is in the allow-set", () => {
        expect.assertions(2);

        const result = filterLogs(MIXED_ENTRIES, criteria({ levels: new Set(["info"]) }));

        expect(result).toHaveLength(2);
        expect(result.every((entry) => entry.level === "info")).toBe(true);
    });

    it("treats a multi-level allow-set as a union", () => {
        expect.assertions(1);

        const result = filterLogs(MIXED_ENTRIES, criteria({ levels: new Set(["error", "warn"]) }));

        expect(result).toHaveLength(2);
    });

    it("matches the function path case-insensitively as a substring", () => {
        expect.assertions(2);

        const result = filterLogs(MIXED_ENTRIES, criteria({ path: "AUTH:" }));

        expect(result).toHaveLength(2);
        expect(result.every((entry) => entry.functionPath?.startsWith("auth:"))).toBe(true);
    });

    it("matches the message case-insensitively as a substring", () => {
        expect.assertions(1);

        expect(filterLogs(MIXED_ENTRIES, criteria({ search: "BOOM" }))).toHaveLength(2);
    });

    it("drops entries older than the relative time window", () => {
        expect.assertions(2);

        // One entry inside the 5m window (NOW), one well outside it (10m back).
        const spanning: LogEntry[] = [
            { functionPath: "fresh:fn", level: "error", message: "fresh", timestamp: NOW },
            { functionPath: "stale:fn", level: "error", message: "stale", timestamp: NOW - 10 * 60 * 1000 },
        ];

        const result = filterLogs(spanning, criteria({ range: "5m" }));

        expect(result).toHaveLength(1);
        expect(result[0]?.message).toBe("fresh");
    });

    it("includes all timestamps for the unbounded `all` range", () => {
        expect.assertions(1);

        const spanning: LogEntry[] = [
            { level: "error", message: "fresh", timestamp: NOW },
            { level: "error", message: "ancient", timestamp: NOW - 24 * 60 * 60 * 1000 },
        ];

        expect(filterLogs(spanning, criteria({ range: "all" }))).toHaveLength(2);
    });

    it("aND-composes level, path, search, and time-range", () => {
        expect.assertions(2);

        const result = filterLogs(MIXED_ENTRIES, criteria({ levels: new Set(["info"]), path: "auth:login", range: "1h", search: "boom" }));

        expect(result).toHaveLength(1);
        expect(result[0]?.message).toBe("BOOM recovered");
    });
});

describe("summarizeLogs", () => {
    it("counts entries per level in severity order, omitting absent levels", () => {
        expect.assertions(2);

        const { byLevel, total } = summarizeLogs(MIXED_ENTRIES);

        expect(total).toBe(4);
        expect(byLevel).toEqual([
            { count: 2, key: "info" },
            { count: 1, key: "warn" },
            { count: 1, key: "error" },
        ]);
    });

    it("counts entries per function path, sorted by count desc then key asc", () => {
        expect.assertions(1);

        const entries: LogEntry[] = [
            { functionPath: "b:fn", level: "error", message: "1", timestamp: 1 },
            { functionPath: "a:fn", level: "error", message: "2", timestamp: 2 },
            { functionPath: "a:fn", level: "error", message: "3", timestamp: 3 },
        ];

        expect(summarizeLogs(entries).byPath).toEqual([
            { count: 2, key: "a:fn" },
            { count: 1, key: "b:fn" },
        ]);
    });

    it("buckets entries without a function path under an em-dash", () => {
        expect.assertions(1);

        const entries: LogEntry[] = [{ level: "info", message: "no path", timestamp: 1 }];

        expect(summarizeLogs(entries).byPath).toEqual([{ count: 1, key: "—" }]);
    });
});

describe("logsPanel — advanced explorer (errors view)", () => {
    it("narrows the rendered rows when a level chip is toggled", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");
        switchToErrors();
        await screen.findAllByTestId("lg-row");

        fireEvent.click(screen.getByTestId("logs-level-info"));

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.textContent?.includes("info"))).toBe(true);
    });

    it("narrows the rendered rows by function-path substring", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");
        switchToErrors();
        await screen.findAllByTestId("lg-row");

        fireEvent.change(screen.getByTestId("logs-path-filter"), { target: { value: "auth:" } });

        const rows = await screen.findAllByTestId("lg-row");

        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.textContent?.includes("auth:"))).toBe(true);
    });

    it("toggles the Summary view to show grouped level and path counts", async () => {
        expect.assertions(3);

        render(renderPanel(createClient(MIXED_ENTRIES)));

        await screen.findByTestId("lg-table");
        switchToErrors();
        await screen.findAllByTestId("lg-row");

        fireEvent.click(screen.getByTestId("logs-summary-toggle"));

        const summary = await screen.findByTestId("logs-summary-total");

        expect(summary.textContent).toContain("4 entries");
        // The list is suppressed while the grouped rollup is up.
        expect(screen.queryByTestId("lg-table")).toBeNull();

        // Two info entries roll up into a single info bucket with a count of 2.
        const levels = screen.getByTestId("logs-summary-levels");

        expect(levels.textContent).toContain("info");
    });
});
