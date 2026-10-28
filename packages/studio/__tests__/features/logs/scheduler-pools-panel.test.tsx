import type { SchedulerStatus } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { SchedulerPoolsPanel } from "../../../src/features/logs/scheduler-pools-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const POOLS_ROW = /^pools-row-/;

const STATUS: SchedulerStatus = {
    backlog: 12,
    inFlight: 3,
    pools: [
        { inFlight: 1, maxConcurrency: 5, name: "quiet", queued: 2 },
        { inFlight: 2, maxConcurrency: 4, name: "busy", queued: 10 },
    ],
};

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

describe("schedulerPoolsPanel", () => {
    it("surfaces the most backed-up pool first", async () => {
        expect.assertions(2);

        render(withProvider(createMockClient(), <SchedulerPoolsPanel loadStatus={async () => STATUS} />));

        await screen.findByTestId("pools-table");

        const rows = screen.getAllByTestId(POOLS_ROW);

        // Supplied quiet-first, so this is the sort, not the input order.
        expect(rows[0]?.dataset.testid).toBe("pools-row-busy");
        expect(rows[1]?.dataset.testid).toBe("pools-row-quiet");
    });

    it("renders the app-wide totals alongside the pool count", async () => {
        expect.assertions(3);

        render(withProvider(createMockClient(), <SchedulerPoolsPanel loadStatus={async () => STATUS} />));

        await screen.findByTestId("pools-totals");

        expect(screen.getByTestId("pools-backlog").textContent).toBe("12");
        expect(screen.getByTestId("pools-inflight").textContent).toBe("3");
        expect(screen.getByTestId("pools-count").textContent).toBe("2");
    });

    it("shows the empty state when no workpool has any activity", async () => {
        expect.assertions(2);

        render(
            withProvider(
                createMockClient(),
                <SchedulerPoolsPanel
                    loadStatus={async () => {
                        return { backlog: 0, inFlight: 0, pools: [] };
                    }}
                />,
            ),
        );

        await expect(screen.findByTestId("pools-empty")).resolves.toBeDefined();
        expect(screen.queryByTestId("pools-table")).toBeNull();
    });

    it("surfaces a failed read instead of rendering an empty panel", async () => {
        expect.assertions(2);

        render(
            withProvider(
                createMockClient(),
                <SchedulerPoolsPanel
                    loadStatus={async () => {
                        throw new Error("scheduler status unavailable");
                    }}
                />,
            ),
        );

        const banner = await screen.findByTestId("pools-error");

        expect(banner.textContent).toContain("scheduler status unavailable");
        // Not mistaken for "no workpools" — an error and an empty result are
        // different answers and only one of them is actionable.
        expect(screen.queryByTestId("pools-empty")).toBeNull();
    });

    // The sort must not mutate the caller's array: the same object is the
    // TanStack cache entry, and an in-place sort would reorder what the next
    // render reads from.
    it("sorts without mutating the loaded status", async () => {
        expect.assertions(1);

        const status: SchedulerStatus = { ...STATUS, pools: [...STATUS.pools] };

        render(withProvider(createMockClient(), <SchedulerPoolsPanel loadStatus={async () => status} />));

        await screen.findByTestId("pools-table");

        expect(status.pools.map((pool) => pool.name)).toStrictEqual(["quiet", "busy"]);
    });
});

describe("schedulerPoolsPanel lag", () => {
    it("lists each job's start lag from the shard's scheduler.lag_ms series", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: (reference): unknown =>
                reference === ADMIN_FUNCTIONS.getMetricSeries
                    ? {
                          series: [
                              {
                                  attributes: { function: "jobs:sweep" },
                                  count: 4,
                                  firstTs: 0,
                                  functionPath: "jobs:sweep",
                                  kind: "histogram",
                                  last: 30,
                                  lastTs: 0,
                                  max: 90,
                                  min: 10,
                                  name: "scheduler.lag_ms",
                                  sum: 160,
                              },
                              {
                                  count: 2,
                                  firstTs: 0,
                                  functionPath: "orders:place",
                                  kind: "counter",
                                  last: 1,
                                  lastTs: 0,
                                  max: 1,
                                  min: 1,
                                  name: "orders.placed",
                                  sum: 2,
                              },
                          ],
                      }
                    : undefined,
        });

        render(withProvider(mock, <SchedulerPoolsPanel loadStatus={async () => STATUS} />));

        const row = await screen.findByTestId("lag-row-jobs:sweep");

        expect(row.textContent).toBe("jobs:sweep4409030");
        expect(screen.getAllByTestId(/^lag-row-/u)).toHaveLength(1);
    });
});
