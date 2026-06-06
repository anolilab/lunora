import { CirrusProvider } from "@cirrus/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { LogEntry, ShardMetrics } from "../src/admin.js";
import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { HealthPanel } from "../src/health-panel.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

const ENTRIES: LogEntry[] = [
    { functionPath: "messages:send", level: "error", message: "boom", timestamp: 1_700_000_002_000 },
    { functionPath: "messages:list", level: "warn", message: "slow query", timestamp: 1_700_000_001_000 },
    { functionPath: "messages:send", level: "error", message: "kapow", timestamp: 1_700_000_000_000 },
];

const METRICS: ShardMetrics = { cache: null, databaseSize: null, errors: 4, requests: 200, shard: "", sinceMs: 0, uptimeMs: 0 };

const unsubscribe = (): void => undefined;

/** The shared mock client doesn't model connection status; `ConnectionBadge` needs it. */
const withConnection = (mock: MockClientHooks): MockClientHooks => {
    Object.assign(mock.asClient, { connectionStatus: () => "connected", onConnectionStatus: () => unsubscribe });

    return mock;
};

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <HealthPanel />
    </CirrusProvider>
);

const clientWith = (entries: LogEntry[]): MockClientHooks =>
    withConnection(
        createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getLogs) {
                    return { entries };
                }

                if (reference === ADMIN_FUNCTIONS.getMetrics) {
                    return METRICS;
                }

                throw new Error(`unexpected ${reference}`);
            },
        }),
    );

describe("healthPanel", () => {
    it("counts error-level entries and lists the recent ones", async () => {
        expect.assertions(2);

        render(renderPanel(clientWith(ENTRIES)));

        await waitFor(() => {
            if (screen.getByTestId("hl-error-count").textContent !== "2") {
                throw new Error("not loaded");
            }
        });

        expect(screen.getByTestId("hl-error-count").textContent).toBe("2");
        expect(screen.getAllByTestId("hl-error-row")).toHaveLength(2);
    });

    it("renders request count and error rate from metrics", async () => {
        expect.assertions(2);

        render(renderPanel(clientWith(ENTRIES)));

        await waitFor(() => {
            if (screen.getByTestId("hl-requests").textContent !== "200") {
                throw new Error("not loaded");
            }
        });

        expect(screen.getByTestId("hl-requests").textContent).toBe("200");
        // 4 errors / 200 requests = 2.0%.
        expect(screen.getByTestId("hl-error-rate").textContent).toBe("2.0%");
    });

    it("shows an empty state when there are no error logs", async () => {
        expect.assertions(1);

        render(renderPanel(clientWith([])));

        await screen.findByTestId("hl-errors-empty");

        expect(screen.getByTestId("hl-errors-empty")).toBeDefined();
    });

    it("surfaces a logs read failure without blanking the rest", async () => {
        expect.assertions(2);

        const mock = withConnection(
            createMockClient({
                query: (reference): unknown => {
                    if (reference === ADMIN_FUNCTIONS.getMetrics) {
                        return METRICS;
                    }

                    throw new Error("ADMIN_FORBIDDEN");
                },
            }),
        );

        render(renderPanel(mock));

        await screen.findByTestId("hl-logs-error");

        expect(screen.getByTestId("hl-logs-error").textContent).toContain("ADMIN_FORBIDDEN");

        // Metrics still rendered despite the logs failure.
        await waitFor(() => {
            if (screen.getByTestId("hl-requests").textContent !== "200") {
                throw new Error("not loaded");
            }
        });

        expect(screen.getByTestId("hl-requests").textContent).toBe("200");
    });
});
