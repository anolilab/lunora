import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

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
    test("renders the health snapshot on mount", async () => {
        render(renderPanel(createClient()));

        await waitFor(() => {
            expect(screen.getByTestId("mt-stats")).toBeDefined();
        });

        expect(screen.getByTestId("mt-requests").textContent).toBe("10");
        expect(screen.getByTestId("mt-errors").textContent).toBe("1 (10.0%)");
        expect(screen.getByTestId("mt-uptime").textContent).toBe("1m 5s");
        expect(screen.getByTestId("mt-db-size").textContent).toBe("1.5 MB");
        expect(screen.getByTestId("mt-cache").textContent).toBe("80.0% (3 entries)");
    });

    test("notes when no cache is configured", async () => {
        render(renderPanel(createClient({ ...METRICS, cache: null })));

        await waitFor(() => {
            expect(screen.getByTestId("mt-cache").textContent).toBe("no cache configured");
        });
    });

    test("forwards the shard key on refresh", async () => {
        const mock = createClient();

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("mt-stats")).toBeDefined();
        });

        fireEvent.change(screen.getByTestId("mt-shard-input"), { target: { value: "room-9" } });
        fireEvent.click(screen.getByTestId("mt-refresh"));

        await waitFor(() => {
            expect(mock.query.mock.calls.length).toBeGreaterThan(1);
        });

        const lastCall = mock.query.mock.calls.at(-1) as [unknown, unknown, { shardKey?: string }];

        expect(lastCall[2]).toEqual({ shardKey: "room-9" });
    });

    test("surfaces an error", async () => {
        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("mt-error").textContent).toBe("ADMIN_FORBIDDEN");
        });
    });
});
