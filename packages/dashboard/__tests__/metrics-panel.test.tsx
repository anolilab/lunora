import { CirrusProvider } from "@cirrus/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ADMIN_FUNCTIONS, type ShardMetrics } from "../src/admin.js";
import { MetricsPanel } from "../src/metrics-panel.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const METRICS: ShardMetrics = {
    cache: { bytes: 2048, entries: 3, evictions: 1, hits: 8, misses: 2 },
    databaseSize: 1_572_864,
    errors: 1,
    requests: 10,
    shard: "__root__",
    sinceMs: 1_700_000_000_000,
    uptimeMs: 65_000,
};

const createClient = (metrics: ShardMetrics = METRICS): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getMetrics) {
                return metrics;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <MetricsPanel />
    </CirrusProvider>
);

describe("metricsPanel", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test("renders the health snapshot on mount", async () => {
        expect.assertions(5);

        render(renderPanel(createClient()));

        await screen.findByTestId("mt-stats");

        expect(screen.getByTestId("mt-requests").textContent).toBe("10");
        expect(screen.getByTestId("mt-errors").textContent).toBe("1 (10.0%)");
        expect(screen.getByTestId("mt-uptime").textContent).toBe("1m 5s");
        expect(screen.getByTestId("mt-db-size").textContent).toBe("1.5 MB");
        expect(screen.getByTestId("mt-cache").textContent).toBe("80.0% (3 entries)");
    });

    test("notes when no cache is configured", async () => {
        expect.assertions(1);

        render(renderPanel(createClient({ ...METRICS, cache: null })));

        const cache = await screen.findByTestId("mt-cache");

        expect(cache.textContent).toBe("no cache configured");
    });

    test("forwards the shard key on refresh", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");

        fireEvent.change(screen.getByTestId("mt-shard-input"), { target: { value: "room-9" } });
        fireEvent.click(screen.getByTestId("mt-refresh"));

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

        const error = await screen.findByTestId("mt-error");

        expect(error.textContent).toBe("ADMIN_FORBIDDEN");
    });

    test("shows a sparkline placeholder before two samples exist", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        const placeholder = await screen.findByTestId("mt-sparkline-empty");

        expect(placeholder.tagName).toBe("SPAN");
        expect(screen.queryByTestId("mt-sparkline")).toBeNull();
    });

    test("toggling Live opens a getMetrics subscription", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");

        expect(mock.subscribe).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId("mt-live"));

        const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __cirrusRef: string } | undefined;

        expect(ref?.__cirrusRef).toBe(ADMIN_FUNCTIONS.getMetrics);
    });

    test("renders a sparkline once at least two live samples accumulate", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        fireEvent.click(screen.getByTestId("mt-live"));

        // Mount seeded `requests: 10`; two climbing pushes → two deltas → spark.
        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getMetrics, { ...METRICS, requests: 15 });
            mock.emit(ADMIN_FUNCTIONS.getMetrics, { ...METRICS, requests: 20 });
        });

        expect(screen.getByTestId("mt-sparkline").dataset.testid).toBe("mt-sparkline");
        expect(screen.queryByTestId("mt-sparkline-empty")).toBeNull();
    });

    test("surfaces a rejected admin subscription as a live-unavailable notice", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        fireEvent.click(screen.getByTestId("mt-live"));

        expect(screen.queryByTestId("mt-live-error")).toBeNull();

        act(() => {
            mock.emitError(ADMIN_FUNCTIONS.getMetrics, "admin subscription requires admin authorization");
        });

        expect(screen.getByTestId("mt-live-error").textContent).toContain("admin subscription requires admin authorization");
    });

    test("clears the live-unavailable notice once a push succeeds", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        fireEvent.click(screen.getByTestId("mt-live"));

        act(() => {
            mock.emitError(ADMIN_FUNCTIONS.getMetrics, "admin subscription requires admin authorization");
        });

        expect(screen.getByTestId("mt-live-error")).not.toBeNull();

        // A subsequent successful push means the channel recovered — banner clears.
        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getMetrics, { ...METRICS, requests: 11 });
        });

        expect(screen.queryByTestId("mt-live-error")).toBeNull();
    });

    test("live pushes update the snapshot and stop once Live is turned off", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        fireEvent.click(screen.getByTestId("mt-live"));

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getMetrics, { ...METRICS, requests: 42 });
        });

        expect(screen.getByTestId("mt-requests").textContent).toBe("42");

        // Turning Live off unsubscribes, so later pushes are ignored.
        fireEvent.click(screen.getByTestId("mt-live"));

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getMetrics, { ...METRICS, requests: 99 });
        });

        expect(screen.getByTestId("mt-requests").textContent).toBe("42");
    });

    test("All shards aggregates getMetrics across the known shards", async () => {
        expect.assertions(3);

        // Seed a recently-visited shard so the aggregate covers more than root.
        sessionStorage.setItem("cirrus-dashboard-recent-shards", JSON.stringify(["room-1"]));

        const mock = createMockClient({
            query: (reference, _args, options): unknown => {
                if (reference !== ADMIN_FUNCTIONS.getMetrics) {
                    throw new Error(`unexpected ${reference}`);
                }

                const shardKey = (options as { shardKey?: string }).shardKey ?? "";

                // Root shard reports 10 requests; room-1 reports 30.
                return shardKey === "room-1"
                    ? { ...METRICS, databaseSize: 1000, errors: 2, requests: 30, shard: "room-1" }
                    : { ...METRICS, databaseSize: 2000, errors: 1, requests: 10, shard: "__root__" };
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        fireEvent.click(screen.getByTestId("mt-aggregate"));

        await screen.findByTestId("mt-aggregate-view");

        // 10 (root) + 30 (room-1) = 40 requests; 1 + 2 = 3 errors.
        expect(screen.getByTestId("mt-agg-requests").textContent).toBe("40");
        expect(screen.getByTestId("mt-agg-errors").textContent).toBe("3");
        // Both shards reachable.
        expect(screen.getByTestId("mt-agg-shards").textContent).toContain("2 reachable");

        sessionStorage.clear();
    });
});
