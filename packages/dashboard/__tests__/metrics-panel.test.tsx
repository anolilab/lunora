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

/**
 * A client whose `getMetrics` reports a `requests` count that climbs by `step`
 * on every call, so consecutive samples yield a non-trivial per-interval delta.
 */
const createIncrementingClient = (step = 5): MockClientHooks => {
    let { requests } = METRICS;

    return createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getMetrics) {
                const snapshot: ShardMetrics = { ...METRICS, requests };

                requests += step;

                return snapshot;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });
};

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

    test("toggling auto-refresh starts polling getMetrics", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const mock = createIncrementingClient();

        render(renderPanel(mock));

        // Let the on-mount fetch resolve.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        const callsAfterMount = mock.query.mock.calls.length;

        fireEvent.click(screen.getByTestId("mt-autorefresh"));

        // Two poll intervals fire two further getMetrics calls.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(4000);
        });

        expect(mock.query.mock.calls.length).toBeGreaterThan(callsAfterMount);
        expect(mock.query).toHaveBeenCalledTimes(callsAfterMount + 2);
    });

    test("renders a sparkline once at least two samples accumulate", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const mock = createIncrementingClient();

        render(renderPanel(mock));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        fireEvent.click(screen.getByTestId("mt-autorefresh"));

        // Mount sample + two polls → two deltas → sparkline appears.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(4000);
        });

        expect(screen.getByTestId("mt-sparkline").dataset.testid).toBe("mt-sparkline");
        expect(screen.queryByTestId("mt-sparkline-empty")).toBeNull();
    });

    test("cleanup stops polling after auto-refresh is turned off", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const mock = createIncrementingClient();

        render(renderPanel(mock));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        fireEvent.click(screen.getByTestId("mt-autorefresh"));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });

        fireEvent.click(screen.getByTestId("mt-autorefresh"));

        const callsAtPause = mock.query.mock.calls.length;

        // No further polls should fire once the interval is cleared.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6000);
        });

        expect(mock.query).toHaveBeenCalledTimes(callsAtPause);
    });
});
