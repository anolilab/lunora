import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    it("batches the index enumeration into one listTablesIndexes call for several tables (STUDIO-04)", async () => {
        expect.assertions(3);

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
                    return [
                        { name: "posts", rowCount: 3 },
                        { name: "users", rowCount: 2 },
                    ];
                }

                if (reference === ADMIN_FUNCTIONS.listTablesIndexes) {
                    return {
                        indexesByTable: {
                            posts: [
                                { fields: ["authorId"], name: "byAuthor", type: "index" },
                                { fields: ["title"], name: "byTitle", type: "index" },
                            ],
                            users: [],
                        },
                    };
                }

                // The per-table RPC must NOT fire when the batched call succeeds —
                // reaching here means the panel fell back unnecessarily.
                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        // The same dead-index reconciliation as the per-table test above, this
        // time answered entirely from the batched response.
        fireEvent.click(await screen.findByTestId("lunora-insights-tab-info"));
        await screen.findByText("Index utilization");

        const view = screen.getByTestId("lunora-insights");

        expect(view.textContent).toContain("Index utilization");
        expect(view.textContent).toContain('Index "byTitle" on table "posts" has recorded no reads');

        // One call covering both tables, not one per table.
        const batchedCalls = mock.query.mock.calls.filter(
            (call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.listTablesIndexes,
        );

        expect(batchedCalls).toHaveLength(1);
    });

    it("degrades a stale batched reply once a shard change supersedes it (stale-shard guard)", async () => {
        expect.assertions(2);

        // shardA's listTablesIndexes reply is deferred — resolved only after
        // shardB's own enumeration has already completed — proving a late-arriving
        // reply for a superseded shard can't clobber the current shard's state.
        let resolveStaleReply: (value: unknown) => void = (_value: unknown) => undefined;
        const staleReply = new Promise((resolve) => {
            resolveStaleReply = resolve;
        });

        const mock = createMockClient({
            query: (reference, _args, options): unknown => {
                const shard = (options as { shardKey?: string } | undefined)?.shardKey ?? "";

                if (reference === ADMIN_FUNCTIONS.getMetrics) {
                    return { ...HEALTHY, indexHits: [] };
                }

                if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                    return EMPTY_STATS;
                }

                if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                    return { advisories: [] };
                }

                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return shard === "shardA" ? [{ name: "legacy", rowCount: 1 }] : [{ name: "posts", rowCount: 1 }];
                }

                if (reference === ADMIN_FUNCTIONS.listTablesIndexes) {
                    return shard === "shardA" ? staleReply : { indexesByTable: { posts: [] } };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <InsightsPanel initialShardKey="shardA" />
            </LunoraProvider>,
        );

        // Wait for shardA's batched call to have been issued (and left pending)
        // before switching shards.
        await waitFor(() => {
            const issued = mock.query.mock.calls.some((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.listTablesIndexes);

            if (!issued) {
                throw new Error("shardA's listTablesIndexes not yet issued");
            }
        });

        // Switch to shardB before shardA's reply lands (debounced 400ms).
        fireEvent.change(screen.getByTestId("in-shard-input"), { target: { value: "shardB" } });

        await waitFor(
            () => {
                const started = mock.query.mock.calls.some(
                    (call) =>
                        (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.listTables &&
                        (call[2] as { shardKey?: string } | undefined)?.shardKey === "shardB",
                );

                if (!started) {
                    throw new Error("shardB enumeration not yet started");
                }
            },
            { timeout: 2000 },
        );

        // NOW resolve shardA's stale reply, well after shardB has taken over —
        // it names a table/index shardB's enumeration never reported.
        resolveStaleReply({ indexesByTable: { legacy: [{ fields: ["x"], name: "stale_index", type: "index" }] } });

        // Give the stale promise's continuation a tick to run — if the guard were
        // broken, this is where it would overwrite `declaredIndexes`.
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });

        const empty = await screen.findByTestId("lunora-insights-empty");

        // shardB's clean state survived: no dead-index advisory at all, and
        // specifically nothing naming the stale shardA index.
        expect(empty.textContent).toContain("No errors detected");
        expect(screen.queryByText(/stale_index/)).toBeNull();
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

        expect(error.textContent).toBe("ADMIN_FORBIDDEN");
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
