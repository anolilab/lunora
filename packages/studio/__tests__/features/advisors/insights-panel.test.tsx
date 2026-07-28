import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InsightsPanel } from "../../../src/features/advisors/insights-panel";
import type { AdvisoryFinding, FunctionStatsResult, MetricsSnapshot, ShardMetrics, ShardTrafficResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const HEALTHY: ShardMetrics = {
    cache: { bytes: 0, entries: 4, evictions: 0, hits: 90, misses: 10 },
    databaseSize: 1024,
    errors: 0,
    requests: 100,
    shard: "__root__",
    sinceMs: 1_700_000_000_000,
    uptimeMs: 1000,
};

const SLOW_STATS: FunctionStatsResult = {
    functions: [
        {
            calls: 3,
            errors: 0,
            lastCalledAt: 1000,
            lastErrorAt: null,
            lastErrorMessage: null,
            maxDurationMs: 4200,
            path: "reports:build",
            scannedTables: [],
            scans: 0,
            totalDurationMs: 9000,
        },
    ],
    sinceMs: 1_700_000_000_000,
};

/** A slow function whose latency is *explained* by a full scan of `posts` — drives the causal missing-index insight. */
const SCAN_STATS: FunctionStatsResult = {
    functions: [
        {
            calls: 3,
            errors: 0,
            lastCalledAt: 1000,
            lastErrorAt: null,
            lastErrorMessage: null,
            maxDurationMs: 4200,
            path: "feed:list",
            scannedTables: [{ scans: 9, table: "posts" }],
            scans: 9,
            totalDurationMs: 9000,
        },
    ],
    sinceMs: 1_700_000_000_000,
};

const EMPTY_STATS: FunctionStatsResult = { functions: [], sinceMs: 1_700_000_000_000 };

/** A skewed cross-shard distribution — one shard owns 80% — so hot_shard fires. */
const loadSkewedTraffic = async (): Promise<ShardTrafficResult> => {
    return {
        failed: 0,
        ok: 2,
        shards: [
            { requests: 80, shardKey: "tenant_busy" },
            { requests: 20, shardKey: "tenant_quiet" },
        ],
    };
};

/** An even cross-shard distribution — ~33% each — so no shard clears the hot-share bar. */
const loadEvenTraffic = async (): Promise<ShardTrafficResult> => {
    return {
        failed: 0,
        ok: 3,
        shards: [
            { requests: 40, shardKey: "tenant_a" },
            { requests: 40, shardKey: "tenant_b" },
            { requests: 40, shardKey: "tenant_c" },
        ],
    };
};

/** One static schema advisory (codegen-time lint) the DO serves via getAdvisories. */
const FK_ADVISORY: AdvisoryFinding = {
    cacheKey: "unindexed_foreign_key:posts:authorId",
    categories: ["PERFORMANCE"],
    description: "A foreign-key column has no index.",
    detail: 'Relation "author" on table "posts" references "users" via column "authorId", which is not the leading column of any index.',
    facing: "EXTERNAL",
    level: "INFO",
    metadata: { table: "posts" },
    name: "unindexed_foreign_key",
    remediation: 'Add a secondary index leading with the FK column, e.g. `.index("byAuthorId", ["authorId"])`.',
    title: "Unindexed foreign key",
};

const createClient = (metrics: ShardMetrics, stats: FunctionStatsResult, advisories: AdvisoryFinding[] = []): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getMetrics) {
                return metrics;
            }

            if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                return stats;
            }

            if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                return { advisories };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <InsightsPanel />
    </LunoraProvider>
);

describe("insightsPanel", () => {
    it("renders a detected slow-function insight on the Info tab", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(HEALTHY, SLOW_STATS)));

        // slow-function is info-severity — it lives under the Info tab.
        fireEvent.click(await screen.findByTestId("lunora-insights-tab-info"));
        await screen.findByText("Slow function");

        const view = screen.getByTestId("lunora-insights");

        expect(view.textContent).toContain("Slow function");
        expect(view.textContent).toContain("reports:build");
    });

    it("renders the causal missing-index chain on the Warnings tab, with an add-index jump", async () => {
        expect.assertions(4);

        render(renderPanel(createClient(HEALTHY, SCAN_STATS)));

        // missing-index is a warning — open the Warnings tab.
        fireEvent.click(await screen.findByTestId("lunora-insights-tab-warning"));
        await screen.findByText("Missing index");

        const view = screen.getByTestId("lunora-insights");

        expect(view.textContent).toContain("Missing index");
        // The function and the table it full-scanned.
        expect(view.textContent).toContain("feed:list");
        expect(view.textContent).toContain("full-scanned posts");

        // The "add the index" deep-link to the Schema/Indexes tab is present.
        const addIndex = await screen.findByTestId("in-add-index-posts");

        expect(addIndex.textContent).toContain("Add index on posts");
    });

    it("renders a static schema advisory from getAdvisories on the Info tab", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(HEALTHY, EMPTY_STATS, [FK_ADVISORY])));

        // unindexed_foreign_key is INFO-severity → the Info tab.
        fireEvent.click(await screen.findByTestId("lunora-insights-tab-info"));
        await screen.findByText("Unindexed foreign key");

        const view = screen.getByTestId("lunora-insights");

        expect(view.textContent).toContain("Unindexed foreign key");
        // The advisory names the offending table.
        expect(view.textContent).toContain("posts");
    });

    it("surfaces a runtime dead-index advisory for a declared index with no recorded reads", async () => {
        expect.assertions(2);

        // getMetrics reports a read for `byAuthor` but NOT `byTitle`; listTableIndexes
        // declares both → `byTitle` reconciles to reads:0 → the runtime dead-index lint fires.
        const metrics: MetricsSnapshot = { ...HEALTHY, indexHits: [{ index: "byAuthor", reads: 5, table: "posts" }] };
        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getMetrics) {
                    return metrics;
                }

                if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                    return EMPTY_STATS;
                }

                if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                    return { advisories: [] };
                }

                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "posts", rowCount: 3 }];
                }

                if (reference === ADMIN_FUNCTIONS.listTableIndexes) {
                    return {
                        indexes: [
                            { fields: ["authorId"], name: "byAuthor", type: "index" },
                            { fields: ["title"], name: "byTitle", type: "index" },
                        ],
                    };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        // index_utilization (dead index) is INFO-severity → the Info tab.
        fireEvent.click(await screen.findByTestId("lunora-insights-tab-info"));
        await screen.findByText("Index utilization");

        const view = screen.getByTestId("lunora-insights");

        expect(view.textContent).toContain("Index utilization");
        expect(view.textContent).toContain('Index "byTitle" on table "posts" has recorded no reads');
    });

    it("auto-refreshes advisories when the tab regains focus (no manual Refresh)", async () => {
        expect.assertions(2);

        let advisories: AdvisoryFinding[] = [];
        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getMetrics) {
                    return HEALTHY;
                }

                if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                    return EMPTY_STATS;
                }

                if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                    return { advisories };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        // Nothing initially.
        fireEvent.click(await screen.findByTestId("lunora-insights-tab-info"));

        expect(screen.queryByText("Unindexed foreign key")).toBeNull();

        // A schema save adds the advisory; tabbing back refetches it in.
        advisories = [FK_ADVISORY];
        fireEvent(document, new Event("visibilitychange"));

        await screen.findByText("Unindexed foreign key");

        expect(screen.getByTestId("lunora-insights").textContent).toContain("Unindexed foreign key");
    });

    it("shows the per-tab empty state when nothing is wrong", async () => {
        expect.assertions(1);

        render(renderPanel(createClient(HEALTHY, EMPTY_STATS)));

        const empty = await screen.findByTestId("lunora-insights-empty");

        expect(empty.textContent).toContain("No errors detected");
    });

    it("still surfaces insights when one snapshot fails (best-effort)", async () => {
        expect.assertions(1);

        // getMetrics fails, getFunctionStats succeeds with a slow function — the
        // panel should still surface the function insight rather than blanking.
        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                    return SLOW_STATS;
                }

                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("lunora-insights-tab-info"));

        const cell = await screen.findByText("reports:build");

        expect(cell.textContent).toContain("reports:build");
    });

    it("surfaces an error only when both snapshots fail", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        const error = await screen.findByTestId("lunora-insights-error");

        // `toContain`, not `toBe`: the alert also carries the "Show in console"
        // affordance (plan 204), so an exact-text assertion pins unrelated chrome.
        expect(error.textContent).toContain("ADMIN_FORBIDDEN");
    });

    it("renders a hot_shard advisory when the cross-shard traffic feed is skewed", async () => {
        expect.assertions(2);

        // One shard absorbs 80 of 100 requests across two shards — the runtime
        // hot_shard lint fires once the studio feeds it the cross-shard feed.
        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getMetrics) {
                    return HEALTHY;
                }

                if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                    return EMPTY_STATS;
                }

                if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                    return { advisories: [] };
                }

                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "messages", rowCount: 3 }];
                }

                if (reference === ADMIN_FUNCTIONS.listTableIndexes) {
                    return { indexes: [] };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <InsightsPanel loadShardTraffic={loadSkewedTraffic} />
            </LunoraProvider>,
        );

        // hot_shard is WARN-severity → the Warnings tab.
        fireEvent.click(await screen.findByTestId("lunora-insights-tab-warning"));
        await screen.findByText("Hot shard");

        const view = screen.getByTestId("lunora-insights");

        expect(view.textContent).toContain("Hot shard");
        expect(view.textContent).toContain('shard "tenant_busy"');
    });

    it("renders no hot_shard advisory on an even cross-shard distribution", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getMetrics) {
                    return HEALTHY;
                }

                if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                    return EMPTY_STATS;
                }

                if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                    return { advisories: [] };
                }

                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "messages", rowCount: 3 }];
                }

                if (reference === ADMIN_FUNCTIONS.listTableIndexes) {
                    return { indexes: [] };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <InsightsPanel loadShardTraffic={loadEvenTraffic} />
            </LunoraProvider>,
        );

        // The empty-state lands once the (only) tab has no rows.
        const empty = await screen.findByTestId("lunora-insights-empty");

        expect(empty.textContent).toContain("No errors detected");
    });
});
