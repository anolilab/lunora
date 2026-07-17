import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MetricsPanel } from "../../../src/features/reports/metrics-panel";
import type { ShardMetrics } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

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
    <LunoraProvider client={mock.asClient}>
        <MetricsPanel />
    </LunoraProvider>
);

describe("metricsPanel", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("renders the health snapshot on mount", async () => {
        expect.assertions(5);

        render(renderPanel(createClient()));

        await screen.findByTestId("mt-stats");

        expect(screen.getByTestId("mt-requests").textContent).toBe("10");
        expect(screen.getByTestId("mt-errors").textContent).toBe("1 (10.0%)");
        expect(screen.getByTestId("mt-uptime").textContent).toBe("1m 5s");
        expect(screen.getByTestId("mt-db-size").textContent).toBe("1.5 MB");
        expect(screen.getByTestId("mt-cache").textContent).toBe("80.0% (3 entries)");
    });

    it("notes when no cache is configured", async () => {
        expect.assertions(1);

        render(renderPanel(createClient({ ...METRICS, cache: null })));

        const cache = await screen.findByTestId("mt-cache");

        expect(cache.textContent).toBe("no cache configured");
    });

    it("re-seeds on a debounced shard-key change", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");

        // No Refresh button: typing a shard re-loads once the value settles.
        fireEvent.change(screen.getByTestId("mt-shard-input"), { target: { value: "room-9" } });

        await waitFor(() => {
            const last = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }] | undefined;

            if (last?.[2]?.shardKey !== "room-9") {
                throw new Error("not re-seeded yet");
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

        const error = await screen.findByTestId("mt-error");

        expect(error.textContent).toBe("ADMIN_FORBIDDEN");
    });

    it("shows a sparkline placeholder before two samples exist", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        const placeholder = await screen.findByTestId("mt-sparkline-empty");

        expect(placeholder.tagName).toBe("SPAN");
        expect(screen.queryByTestId("mt-sparkline")).toBeNull();
    });

    it("opens a getMetrics subscription on mount (always live)", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");

        // No Live toggle: the subscription opens once the mount seed commits a shard.
        await waitFor(() => {
            const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __lunoraRef: string } | undefined;

            if (ref?.__lunoraRef !== ADMIN_FUNCTIONS.getMetrics) {
                throw new Error("not subscribed yet");
            }
        });

        const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __lunoraRef: string } | undefined;

        expect(ref?.__lunoraRef).toBe(ADMIN_FUNCTIONS.getMetrics);
    });

    it("renders a sparkline once at least two live samples accumulate", async () => {
        expect.hasAssertions();

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        await waitFor(() => {
            if (mock.subscribe.mock.calls.length === 0) {
                throw new Error("not subscribed yet");
            }
        });

        // Mount seeded `requests: 10`; two climbing pushes → two deltas → spark.
        // Each push lands in its own act + settle: a real WS delivers them in
        // separate tasks, and two synchronous emits would coalesce into a single
        // cache notification (one data transition → one delta, no sparkline).
        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getMetrics, { ...METRICS, requests: 15 });
        });
        await waitFor(() => {
            expect(screen.getByTestId("mt-requests").textContent).toBe("15");
        });
        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getMetrics, { ...METRICS, requests: 20 });
        });

        await waitFor(() => {
            expect(screen.getByTestId("mt-sparkline").dataset.testid).toBe("mt-sparkline");
        });

        expect(screen.queryByTestId("mt-sparkline-empty")).toBeNull();
    });

    it("surfaces a rejected admin subscription as a live-unavailable notice", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        await waitFor(() => {
            if (mock.subscribe.mock.calls.length === 0) {
                throw new Error("not subscribed yet");
            }
        });

        expect(screen.queryByTestId("mt-live-error")).toBeNull();

        act(() => {
            mock.emitError(ADMIN_FUNCTIONS.getMetrics, "admin subscription requires admin authorization");
        });

        expect(screen.getByTestId("mt-live-error").textContent).toContain("admin subscription requires admin authorization");
    });

    it("clears the live-unavailable notice once a push succeeds", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        await waitFor(() => {
            if (mock.subscribe.mock.calls.length === 0) {
                throw new Error("not subscribed yet");
            }
        });

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

    it("live pushes update the snapshot without any interaction", async () => {
        expect.hasAssertions();

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("mt-stats");
        await waitFor(() => {
            if (mock.subscribe.mock.calls.length === 0) {
                throw new Error("not subscribed yet");
            }
        });

        expect(screen.getByTestId("mt-requests").textContent).toBe("10");

        // No toggle: a server push lands and updates the panel on its own. The
        // push flows through the query cache, whose observer notification lands
        // asynchronously — poll for the re-render instead of asserting sync.
        act(() => {
            mock.emit(ADMIN_FUNCTIONS.getMetrics, { ...METRICS, requests: 42 });
        });

        await waitFor(() => {
            expect(screen.getByTestId("mt-requests").textContent).toBe("42");
        });
    });

    it("all shards aggregates getMetrics across the known shards", async () => {
        expect.assertions(3);

        // Seed a recently-visited shard so the aggregate covers more than root.
        sessionStorage.setItem("lunora-studio-recent-shards", JSON.stringify(["room-1"]));

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
