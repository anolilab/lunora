import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { HealthPanel } from "../../../src/features/reports/health-panel";
import type { AuthMetrics, FunctionCallStat, LogEntry, MetricsSnapshot, MigrationStatusRow, ShardMetrics } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

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
    <LunoraProvider client={mock.asClient}>
        <HealthPanel />
    </LunoraProvider>
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

/** A getMetrics snapshot with two time buckets so the request/error sparkline has a line to draw. */
const SNAPSHOT: MetricsSnapshot = {
    cache: null,
    databaseSize: null,
    errors: 4,
    history: [
        { bucketMs: 1000, calls: 10, errors: 1, path: "a:b" },
        { bucketMs: 1000, calls: 5, errors: 0, path: "c:d" },
        { bucketMs: 2000, calls: 20, errors: 2, path: "a:b" },
    ],
    requests: 200,
    shard: "",
    sinceMs: 0,
    uptimeMs: 0,
};

const fnStat = (path: string, calls: number, errors: number): FunctionCallStat => {
    return {
        calls,
        errors,
        lastCalledAt: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
        maxDurationMs: 0,
        path,
        totalDurationMs: 0,
    };
};

const AUTH: AuthMetrics = {
    attempts: 100,
    failureRate: 0.05,
    failures: 5,
    history: [
        { attempts: 50, bucketMs: 1000, failures: 2 },
        { attempts: 50, bucketMs: 2000, failures: 3 },
    ],
    sinceMs: 0,
};

const MIGRATIONS: MigrationStatusRow[] = [
    { changed: 0, cursor: null, direction: "up", error: null, id: "m1", processed: 0, startedAt: 0, status: "completed", updatedAt: 0 },
];

/** A client that answers every SLO read, including the `schedulerStatus` client method. */
const sloClient = (): MockClientHooks => {
    const mock = withConnection(
        createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getLogs) {
                    return { entries: ENTRIES };
                }

                if (reference === ADMIN_FUNCTIONS.getMetrics) {
                    return SNAPSHOT;
                }

                if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                    return { functions: [fnStat("a:b", 100, 10), fnStat("c:d", 50, 0)] };
                }

                if (reference === ADMIN_FUNCTIONS.getAuthMetrics) {
                    return AUTH;
                }

                if (reference === ADMIN_FUNCTIONS.migrationStatus) {
                    return { migrations: MIGRATIONS };
                }

                throw new Error(`unexpected ${reference}`);
            },
        }),
    );

    Object.assign(mock.asClient, {
        schedulerStatus: () => Promise.resolve({ backlog: 3, inFlight: 1, pools: [{ inFlight: 1, maxConcurrency: 5, name: "default", queued: 3 }] }),
    });

    return mock;
};

describe("healthPanel SLO view", () => {
    it("composes the SLO tiles from every signal", async () => {
        expect.assertions(4);

        render(renderPanel(sloClient()));

        // 4 errors / 200 requests = 2.0% (warn band).
        await waitFor(() => {
            if (screen.getByTestId("hl-slo-errorrate").textContent !== "2.0%") {
                throw new Error("not loaded");
            }
        });

        expect(screen.getByTestId("hl-slo-errorrate").textContent).toBe("2.0%");
        // 5 failures / 100 attempts = 5.0%.
        expect(screen.getByTestId("hl-slo-auth").textContent).toBe("5.0%");
        // backlog from the scheduler client method.
        expect(screen.getByTestId("hl-slo-backlog").textContent).toBe("3");
        // one completed migration → healthy.
        expect(screen.getByTestId("hl-slo-migrations").textContent).toBe("OK");
    });

    it("lists functions worst error-rate first and draws the request sparkline", async () => {
        expect.assertions(3);

        render(renderPanel(sloClient()));

        await screen.findByTestId("hl-spark-requests");

        const rows = screen.getAllByTestId("hl-fn-row");

        // Both functions ran, so both list; `a:b` (10%) sorts before `c:d` (0%).
        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("a:b");
        // Two history buckets → the durable request sparkline renders.
        expect(screen.getByTestId("hl-spark-requests")).toBeDefined();
    });

    it("degrades each SLO tile to — when its read fails, without blanking the panel", async () => {
        expect.assertions(2);

        // Only metrics answers; every other SLO read throws.
        const mock = withConnection(
            createMockClient({
                query: (reference): unknown => {
                    if (reference === ADMIN_FUNCTIONS.getMetrics) {
                        return SNAPSHOT;
                    }

                    throw new Error("ADMIN_FORBIDDEN");
                },
            }),
        );

        render(renderPanel(mock));

        // Error rate still comes from metrics…
        await waitFor(() => {
            if (screen.getByTestId("hl-slo-errorrate").textContent !== "2.0%") {
                throw new Error("not loaded");
            }
        });

        expect(screen.getByTestId("hl-slo-errorrate").textContent).toBe("2.0%");
        // …while auth (and scheduler, absent here) fall back to the em-dash.
        expect(screen.getByTestId("hl-slo-auth").textContent).toBe("—");
    });
});

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

    it("reports the TOTAL error count even though the list is capped", async () => {
        expect.assertions(2);

        // Eight errors against a display cap of five. The badge is the only thing
        // telling the operator the volume, which is the signal that matters during an
        // incident — a badge that saturates at the cap says nothing. The case above
        // stays under the cap, so it passes either way and cannot catch this.
        const many: LogEntry[] = Array.from({ length: 8 }, (_, index) => {
            return {
                functionPath: "messages:send",
                level: "error" as const,
                message: `boom ${index.toString()}`,
                timestamp: 1_700_000_000_000 + index * 1000,
            };
        });

        render(renderPanel(clientWith(many)));

        await waitFor(() => {
            if (screen.getByTestId("hl-error-count").textContent !== "8") {
                throw new Error("not loaded");
            }
        });

        expect(screen.getByTestId("hl-error-count").textContent).toBe("8");
        expect(screen.getAllByTestId("hl-error-row")).toHaveLength(5);
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
