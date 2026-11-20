import { describe, expect, it, vi } from "vitest";

import { isRequestSpan, percentile } from "../lunora/traffic";
import type { TrafficFilter } from "../src/telemetry/traffic-read";
import {
    buildTrafficDimensionQuery,
    buildTrafficSeriesQuery,
    buildTrafficStatusQuery,
    createTrafficReader,
    foldTrafficBreakdown,
    foldTrafficSeries,
    foldTrafficStatus,
    MAX_TRAFFIC_SCRIPTS,
} from "../src/telemetry/traffic-read";

const FILTER: TrafficFilter = {
    dataset: "lunora_tenant_usage",
    scriptNames: ["acme-app-v3", "acme-app-v2"],
    sinceSec: 1_700_000_000,
    toSec: 1_700_086_400,
};

describe(buildTrafficDimensionQuery, () => {
    it("groups on the blob the dimension maps to", () => {
        expect(buildTrafficDimensionQuery(FILTER, "country").query).toContain("blob5 AS key");
        expect(buildTrafficDimensionQuery(FILTER, "route").query).toContain("blob4 AS key");
        expect(buildTrafficDimensionQuery(FILTER, "hostname").query).toContain("blob6 AS key");
        expect(buildTrafficDimensionQuery(FILTER, "status").query).toContain("blob7 AS key");
    });

    it("reads the dataset as its Analytics Engine table", () => {
        expect(buildTrafficDimensionQuery(FILTER, "country").query).toContain('FROM events.analyticsEngine."lunora_tenant_usage"');
    });

    /**
     * The same sampling regression the usage rollup pins, in the read path the
     * dashboard shows a human: `SUM(double1)` counts RETAINED rows, not the
     * requests they stand in for, and AE only starts sampling once traffic
     * spikes — so the bare sum reads lowest exactly when an operator has opened
     * the page because something spiked. The dialect's `COUNT(*)` is weighted.
     */
    it("counts sample-weighted events, never the raw double", () => {
        const { query } = buildTrafficDimensionQuery(FILTER, "country");

        expect(query).toContain("COUNT(*) AS requests");
        expect(query).not.toContain("SUM(double1)");
    });

    /**
     * The org scope. The metering dataset carries no organization dimension, so
     * the ONLY thing keeping one tenant out of another's traffic is that the
     * query names the caller's own scripts. A build that drops this clause reads
     * the whole platform's traffic and would look perfectly healthy doing it.
     */
    it("scopes every read to the caller's own script names", () => {
        const { params, query } = buildTrafficDimensionQuery(FILTER, "country");

        expect(query).toContain("index1 IN ($script0, $script1)");
        expect(params).toMatchObject({ script0: "acme-app-v3", script1: "acme-app-v2" });
    });

    it("bounds the script list so a huge org cannot build an unbounded query", () => {
        const many = Array.from({ length: MAX_TRAFFIC_SCRIPTS + 50 }, (_, index) => `script-${String(index)}`);
        const { params, query } = buildTrafficDimensionQuery({ ...FILTER, scriptNames: many }, "country");

        expect(params.script0).toBe("script-0");
        expect(params[`script${String(MAX_TRAFFIC_SCRIPTS - 1)}`]).toBe(`script-${String(MAX_TRAFFIC_SCRIPTS - 1)}`);
        expect(params).not.toHaveProperty(`script${String(MAX_TRAFFIC_SCRIPTS)}`);
        expect(query).not.toContain(`$script${String(MAX_TRAFFIC_SCRIPTS)}`);
    });

    it("binds a script name rather than splicing it into the statement", () => {
        const { params, query } = buildTrafficDimensionQuery({ ...FILTER, scriptNames: ["ac'me"] }, "country");

        expect(query).not.toContain("ac'me");
        expect(params.script0).toBe("ac'me");
    });

    it("applies the domain filter only when one is given", () => {
        expect(buildTrafficDimensionQuery(FILTER, "route").query).not.toContain("blob6 =");
        expect(buildTrafficDimensionQuery(FILTER, "route").params).not.toHaveProperty("hostname");

        const filtered = buildTrafficDimensionQuery({ ...FILTER, hostname: "app.acme.com" }, "route");

        expect(filtered.query).toContain("blob6 = $hostname");
        expect(filtered.params.hostname).toBe("app.acme.com");
    });

    it("bounds the window at both ends", () => {
        const { params, query } = buildTrafficDimensionQuery(FILTER, "country");

        expect(query).toContain("timestamp > $since AND timestamp <= $to");
        expect(params).toMatchObject({ since: "2023-11-14T22:13:20Z", to: "2023-11-15T22:13:20Z" });
    });
});

describe(buildTrafficStatusQuery, () => {
    it("groups on class AND exact code so one read fills the nested view", () => {
        const { query } = buildTrafficStatusQuery(FILTER);

        expect(query).toContain("blob3 AS class");
        expect(query).toContain("blob7 AS code");
        expect(query).toContain("GROUP BY class, code");
    });
});

describe(buildTrafficSeriesQuery, () => {
    it("buckets on the requested width as epoch seconds", () => {
        expect(buildTrafficSeriesQuery(FILTER, 900).query).toContain("toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '900' SECOND)) AS bucket");
    });

    /**
     * A summed value under sampling has to be weighted the same way a count is,
     * and a mean has to be the weighted mean. The Analytics SQL dialect weights
     * `SUM` and `AVG` itself, so the statement must use them — and must not reach
     * for the old AE SQL API's `_sample_interval`, which this dialect does not have
     * and would double-weight if it did.
     */
    it("sample-weights the summed bytes and the mean duration through the dialect", () => {
        const { query } = buildTrafficSeriesQuery(FILTER, 900);

        expect(query).toContain("COUNT(*) AS requests, SUM(double3) AS bytes, AVG(double2) AS avgDurationMs");
        expect(query).not.toContain("_sample_interval");
    });
});

describe(foldTrafficBreakdown, () => {
    it("computes each row's share of the returned rows", () => {
        const rows = foldTrafficBreakdown([
            { key: "US", requests: "75" },
            { key: "DE", requests: "25" },
        ]);

        expect(rows).toStrictEqual([
            { key: "US", requests: 75, share: 0.75 },
            { key: "DE", requests: 25, share: 0.25 },
        ]);
    });

    it("drops empty keys and zero counts rather than rendering a blank row", () => {
        expect(
            foldTrafficBreakdown([
                { key: "", requests: "10" },
                { key: "US", requests: "0" },
            ]),
        ).toStrictEqual([]);
    });

    it("does not divide by zero when nothing survives", () => {
        expect(foldTrafficBreakdown([])).toStrictEqual([]);
    });
});

describe(foldTrafficStatus, () => {
    it("nests exact codes under their class and sums the class", () => {
        const classes = foldTrafficStatus([
            { class: "2xx", code: "200", requests: "80" },
            { class: "2xx", code: "204", requests: "20" },
            { class: "5xx", code: "500", requests: "3" },
        ]);

        expect(classes).toStrictEqual([
            {
                class: "2xx",
                codes: [
                    { code: "200", requests: 80 },
                    { code: "204", requests: 20 },
                ],
                requests: 100,
            },
            { class: "5xx", codes: [{ code: "500", requests: 3 }], requests: 3 },
        ]);
    });

    /**
     * A point written before the exact-code dimension existed carries
     * `code: "unknown"`. Its requests must still count toward the class total —
     * dropping it would make the class bars silently under-report across the
     * window that straddles the widening's deploy.
     */
    it("counts a point with no exact code toward its class without listing it", () => {
        const classes = foldTrafficStatus([{ class: "4xx", code: "unknown", requests: "7" }]);

        expect(classes).toStrictEqual([{ class: "4xx", codes: [], requests: 7 }]);
    });
});

describe(foldTrafficSeries, () => {
    it("converts the AE second-resolution bucket to epoch ms", () => {
        expect(foldTrafficSeries([{ avgDurationMs: "12.5", bucket: "1700000000", bytes: "4096", requests: "9" }])).toStrictEqual([
            { avgDurationMs: 12.5, bytes: 4096, requests: 9, t: 1_700_000_000_000 },
        ]);
    });
});

describe(createTrafficReader, () => {
    const okResponse = (rows: unknown[]): Response => Response.json({ data: rows }, { status: 200 });

    it("issues the five reads together and folds them into one snapshot", async () => {
        const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
            const body = (init as undefined | { body?: string })?.body ?? "";

            expect(JSON.parse(body)).toMatchObject({ scope: { accountTag: "acc" } });

            if (body.includes("blob5 AS key")) {
                return okResponse([
                    { key: "US", requests: "60" },
                    { key: "BR", requests: "40" },
                ]);
            }

            if (body.includes("blob4 AS key")) {
                return okResponse([{ key: "/orders/:id", requests: "70" }]);
            }

            if (body.includes("blob6 AS key")) {
                return okResponse([{ key: "app.acme.com", requests: "100" }]);
            }

            if (body.includes("blob3 AS class")) {
                return okResponse([{ class: "2xx", code: "200", requests: "95" }]);
            }

            return okResponse([{ avgDurationMs: "18", bucket: "1700000000", bytes: "1024", requests: "100" }]);
        });

        const reader = createTrafficReader({ accountId: "acc", apiToken: "tok", dataset: "usage", fetch: fetchMock });
        const snapshot = await reader.readSnapshot({ from: 1_700_000_000_000, scriptNames: ["acme-app"], to: 1_700_086_400_000 });

        expect(fetchMock).toHaveBeenCalledTimes(5);
        expect(snapshot.countries.map((row) => row.key)).toStrictEqual(["US", "BR"]);
        expect(snapshot.routes[0]?.key).toBe("/orders/:id");
        expect(snapshot.hostnames[0]?.key).toBe("app.acme.com");
        expect(snapshot.statuses[0]?.class).toBe("2xx");
        expect(snapshot.series[0]?.requests).toBe(100);
        expect(snapshot.totalRequests).toBe(100);
    });

    /**
     * The hostname breakdown IS the domain filter's option list, so it must be
     * read unfiltered. Applying the filter to it looks like a consistency fix and
     * would leave the picker holding one option the moment anyone used it — a
     * dead end a reader of the reader alone would not spot.
     */
    it("reads the hostname breakdown unfiltered while every other view honours the domain filter", async () => {
        const queries: { params: Record<string, string>; query: string }[] = [];
        const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
            queries.push(JSON.parse((init as undefined | { body?: string })?.body ?? "{}") as { params: Record<string, string>; query: string });

            return okResponse([]);
        });

        const reader = createTrafficReader({ accountId: "acc", apiToken: "tok", dataset: "usage", fetch: fetchMock });

        await reader.readSnapshot({ from: 0, hostname: "app.acme.com", scriptNames: ["acme-app"], to: 1_000_000 });

        const hostnameQuery = queries.find((request) => request.query.includes("blob6 AS key"));
        const countryQuery = queries.find((request) => request.query.includes("blob5 AS key"));

        expect(hostnameQuery?.query).not.toContain("blob6 = $hostname");
        expect(hostnameQuery?.params).not.toHaveProperty("hostname");
        expect(countryQuery?.query).toContain("blob6 = $hostname");
        expect(countryQuery?.params.hostname).toBe("app.acme.com");
        // The org scope still applies to the unfiltered read — dropping the domain
        // filter must never mean dropping the tenant boundary with it.
        expect(hostnameQuery?.query).toContain("index1 IN ($script0)");
        expect(hostnameQuery?.params.script0).toBe("acme-app");
    });

    /**
     * `index1 IN ()` is not valid SQL, so an org that has deployed nothing must be
     * answered locally. Without this the Traffic tab would 500 for exactly the
     * users most likely to be looking at it — the ones who just signed up.
     */
    it("answers an org with no deployments without a round trip", async () => {
        const fetchMock = vi.fn<typeof globalThis.fetch>();
        const reader = createTrafficReader({ accountId: "acc", apiToken: "tok", dataset: "usage", fetch: fetchMock });

        const snapshot = await reader.readSnapshot({ from: 0, scriptNames: [], to: 1 });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(snapshot.totalRequests).toBe(0);
        expect(snapshot.countries).toStrictEqual([]);
    });
});

/**
 * The live stream's root-span predicate. This is a regression test with a story:
 * the first cut used `=== undefined`, which reads as obviously correct and made
 * the entire panel render permanently empty against real seeded data — an absent
 * optional column comes back from the store as `null`. Nothing errored and no test
 * failed; the rows were simply invisible, which is the worst shape a bug can take
 * on a dashboard whose whole job is telling you what is happening.
 */
describe(isRequestSpan, () => {
    it("treats a span with no parent as a request, however absence is represented", () => {
        expect(isRequestSpan({})).toBe(true);
        expect(isRequestSpan({ parentSpanId: undefined })).toBe(true);
        expect(isRequestSpan({ parentSpanId: null })).toBe(true);
    });

    it("excludes work nested inside a request", () => {
        expect(isRequestSpan({ parentSpanId: "a1b2c3" })).toBe(false);
    });
});

/**
 * Nearest-rank percentiles over the unsampled span window.
 *
 * Untested until a review pointed out that a statistic can silently become a
 * different statistic — nothing errors when a p95 quietly turns into a p50, and
 * an operator comparing it against a trace in the list below has no way to tell.
 */
describe(percentile, () => {
    const ascending = Array.from({ length: 100 }, (_, index) => index + 1);

    it("returns nearest-rank values, so every answer is a duration some request took", () => {
        expect(percentile(ascending, 0.5)).toBe(50);
        expect(percentile(ascending, 0.95)).toBe(95);
        expect(percentile(ascending, 0.99)).toBe(99);
    });

    /** Interpolation would produce a p95 that appears nowhere in the data. */
    it("never invents a value between two samples", () => {
        expect(percentile([10, 20], 0.5)).toBe(10);
        expect(percentile([10, 20], 0.75)).toBe(20);
    });

    it("answers the ends without running off the array", () => {
        expect(percentile(ascending, 0)).toBe(1);
        expect(percentile(ascending, 1)).toBe(100);
    });

    it("answers zero for an empty window rather than NaN", () => {
        expect(percentile([], 0.95)).toBe(0);
    });

    it("reads a single-sample window as that sample at every rank", () => {
        expect(percentile([42], 0.5)).toBe(42);
        expect(percentile([42], 0.99)).toBe(42);
    });
});
