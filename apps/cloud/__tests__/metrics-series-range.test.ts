import { describe, expect, it } from "vitest";

import { series } from "../lunora/metrics";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/** D1's page ceiling: `findMany` never answers more rows than this, whatever `limit` asks. */
const D1_PAGE_CAP = 1000;

type Range = { gt?: number; gte?: number; lt?: number; lte?: number };

const inRange = (actual: unknown, range: Range): boolean =>
    typeof actual === "number" &&
    (range.gt === undefined || actual > range.gt) &&
    (range.gte === undefined || actual >= range.gte) &&
    (range.lt === undefined || actual < range.lt) &&
    (range.lte === undefined || actual <= range.lte);

/**
 * `metricPoints` the way D1 answers it: filtered by `where` (equality and range
 * operators), ordered by `at`, and paged — at most {@link D1_PAGE_CAP} rows, with a
 * cursor to the rest. The shared fake answers every match in one page, which hides
 * a read that filters after a bounded page.
 */
const d1MetricPoints = (rows: Row[]) => {
    return {
        findMany: (args: { cursor?: null | string; limit?: number; orderBy?: { at: "asc" | "desc" }[]; where?: Record<string, unknown> }) => {
            const matching = rows
                .filter((row) =>
                    Object.entries(args.where ?? {}).every(([field, value]) =>
                        typeof value === "object" && value !== null ? inRange(row[field], value as Range) : row[field] === value,
                    ),
                )
                .toSorted((a, b) => (args.orderBy?.[0]?.at === "desc" ? (b["at"] as number) - (a["at"] as number) : (a["at"] as number) - (b["at"] as number)));
            const start = args.cursor ? Number(args.cursor) : 0;
            const end = start + Math.min(args.limit ?? D1_PAGE_CAP, D1_PAGE_CAP);
            const isDone = end >= matching.length;

            return Promise.resolve({ continueCursor: isDone ? null : String(end), isDone, page: matching.slice(start, end) });
        },
    };
};

type SeriesRead = { series: { points: { t: number; value: number }[] }[]; truncated: boolean };

const point = (at: number, value: number): Row => {
    return { _id: `mp_${String(at)}`, at, createdAt: at, kind: "gauge", name: "queue_depth", organizationId: "org_1", value };
};

describe("metrics.series", () => {
    it("reads every point of the range, however many newer points the organization has", async () => {
        expect.assertions(1);

        // 100 fifteen-minute buckets, 1500 points: more than one D1 page inside the range alone.
        const bucketMs = 15 * 60 * 1000;
        const from = 0;
        const to = 100 * bucketMs;
        const inWindow = Array.from({ length: 1500 }, (_, index) => point(from + index * 60_000, 1));
        // A busier, later tail (and a future-dated point) that fills any newest-first page before the range.
        const newer = [...Array.from({ length: 6000 }, (_, index) => point(to + 1 + index, 9)), point(9_999_999_999, 9)];
        const { ctx } = makeCtx({ members: [owner("org_1")] }, { now: to + 10_000 });

        (ctx.db as unknown as Record<string, unknown>)["metricPoints"] = d1MetricPoints([...newer, ...inWindow]);

        const read = (await series.handler(ctx, { from, organizationId: "org_1", to } as never)) as SeriesRead;
        const [only, ...rest] = read.series;

        expect({
            buckets: only?.points.length,
            first: only?.points[0]?.t,
            others: rest.length,
            truncated: read.truncated,
            values: [...new Set(only?.points.map((sample) => sample.value))],
        }).toStrictEqual({
            buckets: 100,
            first: from,
            others: 0,
            truncated: false,
            values: [1],
        });
    });

    it("stops at its page budget, flags the read truncated and drops the bucket it cut into", async () => {
        expect.assertions(1);

        // 12 000 points one second apart: 12 D1 pages, past the 10-page budget of a live run.
        const bucketMs = 15 * 60 * 1000;
        const total = 12_000;
        const inWindow = Array.from({ length: total }, (_, index) => point(index * 1000, 1));
        const to = total * 1000;
        const { ctx } = makeCtx({ members: [owner("org_1")] }, { now: to + 10_000 });
        let pages = 0;
        const table = d1MetricPoints(inWindow);

        (ctx.db as unknown as Record<string, unknown>)["metricPoints"] = {
            findMany: (args: Parameters<typeof table.findMany>[0]) => {
                pages += 1;

                return table.findMany(args);
            },
        };

        const read = (await series.handler(ctx, { from: 0, organizationId: "org_1", to } as never)) as SeriesRead;
        // Newest-first, 10 pages reach back to at = 2 000 000, inside the bucket starting at 1 800 000;
        // that bucket was read only in part, so the first one charted is the next.
        const firstKept = 3 * bucketMs;

        expect({ first: read.series[0]?.points[0]?.t, pages, truncated: read.truncated }).toStrictEqual({ first: firstKept, pages: 10, truncated: true });
    });

    it("keeps the one bucket a burst denser than the page budget fills, rather than charting nothing", async () => {
        expect.assertions(1);

        // 12 000 points inside a single fifteen-minute bucket: the budget runs out inside it.
        const burst = Array.from({ length: 12_000 }, (_, index) => point(index * 10, 1));
        const to = 15 * 60 * 1000 - 1;
        const { ctx } = makeCtx({ members: [owner("org_1")] }, { now: to + 10_000 });

        (ctx.db as unknown as Record<string, unknown>)["metricPoints"] = d1MetricPoints(burst);

        const read = (await series.handler(ctx, { from: 0, organizationId: "org_1", to } as never)) as SeriesRead;

        expect({ buckets: read.series[0]?.points.length, truncated: read.truncated }).toStrictEqual({ buckets: 1, truncated: true });
    });
});
