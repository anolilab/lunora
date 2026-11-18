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

        const [only, ...rest] = (await series.handler(ctx, { from, organizationId: "org_1", to } as never)) as { points: { t: number; value: number }[] }[];

        expect({
            buckets: only?.points.length,
            first: only?.points[0]?.t,
            others: rest.length,
            values: [...new Set(only?.points.map((sample) => sample.value))],
        }).toStrictEqual({
            buckets: 100,
            first: from,
            others: 0,
            values: [1],
        });
    });
});
