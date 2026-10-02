import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import LogTailer from "../../src/daemon/log-tailer";
import { ReportQueue, REPORTS_PER_DRAIN } from "../../src/daemon/report-queue";
import { parseAccessLine, ReportAggregator } from "../../src/daemon/reports";
import type { ReportMessage } from "../../src/wire/types";

const MINUTE = 60_000;
const T0 = 1_790_000_040_000; // a whole minute

const line = (at: number, host: string, status = 200, durationSeconds = 0.01): string =>
    JSON.stringify({ duration: durationSeconds, logger: "http.log.access.lunora", request: { host, method: "GET" }, status, ts: at / 1000 });

const ROUTES = [
    { alias: "shop", hostname: "shop.bx.boxes.test" },
    { alias: "docs", hostname: "docs.bx.boxes.test" },
];

describe(parseAccessLine, () => {
    it("reads time, host (port dropped, lowercased), status and duration", () => {
        expect.assertions(2);

        expect(parseAccessLine(line(T0 + 1500, "Shop.BX.boxes.test:443", 502, 0.25))).toStrictEqual({
            at: T0 + 1500,
            durationMs: 250,
            host: "shop.bx.boxes.test",
            status: 502,
        });
        expect(parseAccessLine("not json")).toBeUndefined();
    });
});

describe(ReportAggregator, () => {
    it("reports only closed, whole-minute windows, per alias", () => {
        expect.assertions(3);

        const aggregator = new ReportAggregator();

        aggregator.setRoutes(ROUTES);
        aggregator.ingest(line(T0 + 1000, "shop.bx.boxes.test", 200, 0.01));
        aggregator.ingest(line(T0 + 2000, "shop.bx.boxes.test", 500, 0.03));
        aggregator.ingest(line(T0 + 3000, "shop.bx.boxes.test", 200, 0.02));
        aggregator.ingest(line(T0 + 4000, "docs.bx.boxes.test"));
        aggregator.ingest(line(T0 + MINUTE + 1000, "docs.bx.boxes.test"));

        // The first minute has not closed (grace included) — nothing yet.
        expect(aggregator.close(T0 + MINUTE + 1000)).toStrictEqual([]);

        const [report, ...rest] = aggregator.close(T0 + MINUTE + 6000);

        expect(report).toStrictEqual({
            perAlias: [
                { alias: "shop", errors: 1, p50Ms: 20, requests: 3 },
                { alias: "docs", errors: 0, p50Ms: 10, requests: 1 },
            ],
            type: "report",
            windowEnd: T0 + MINUTE,
            windowStart: T0,
        } satisfies ReportMessage);
        expect(rest).toStrictEqual([]);
    });

    it("drops unrouted hosts, and late lines for a window it already reported", () => {
        expect.assertions(2);

        const aggregator = new ReportAggregator();

        aggregator.setRoutes(ROUTES);
        aggregator.ingest(line(T0 + 1000, "unknown.example"));
        aggregator.ingest(line(T0 + 1000, "shop.bx.boxes.test"));

        expect(aggregator.close(T0 + 2 * MINUTE)).toHaveLength(1);

        aggregator.ingest(line(T0 + 2000, "shop.bx.boxes.test"));

        expect(aggregator.close(T0 + 3 * MINUTE)).toStrictEqual([]);
    });

    it("caps a report at the protocol's 500 aliases, busiest first", () => {
        expect.assertions(2);

        const aggregator = new ReportAggregator();
        const routes = Array.from({ length: 520 }, (_, index) => {
            return { alias: `a${String(index)}`, hostname: `a${String(index)}.bx.test` };
        });

        aggregator.setRoutes(routes);
        routes.forEach((route, index) => {
            for (let count = 0; count <= index % 3; count += 1) {
                aggregator.ingest(line(T0 + 1000, route.hostname));
            }
        });

        const [report] = aggregator.close(T0 + 2 * MINUTE);

        expect(report?.perAlias).toHaveLength(500);
        expect(report?.perAlias[0]?.requests).toBe(3);
    });
});

describe(ReportQueue, () => {
    const report = (windowStart: number): ReportMessage => {
        return { perAlias: [], type: "report", windowEnd: windowStart + MINUTE, windowStart };
    };

    it("drains a few reports at a time, oldest first, and keeps what could not be sent", () => {
        expect.assertions(4);

        const queue = new ReportQueue();
        const sent: number[] = [];

        queue.push(Array.from({ length: 8 }, (_, index) => report(T0 + index * MINUTE)));

        expect(
            queue.drain(
                (message) => {
                    sent.push(message.windowStart);

                    return true;
                },
                T0 + 10 * MINUTE,
            ),
        ).toBe(REPORTS_PER_DRAIN);
        expect(queue.drain(() => false, T0 + 10 * MINUTE)).toBe(0);
        expect(queue.size).toBe(8 - REPORTS_PER_DRAIN);
        expect(sent).toStrictEqual(Array.from({ length: REPORTS_PER_DRAIN }, (_, index) => T0 + index * MINUTE));
    });

    it("forgets windows older than a day, which the control plane refuses", () => {
        expect.assertions(1);

        const queue = new ReportQueue();

        queue.push([report(T0)]);
        queue.drain(() => false, T0 + 25 * 60 * MINUTE);

        expect(queue.size).toBe(0);
    });
});

describe(LogTailer, () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-hostd-tail-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("reads appended lines from where the daemon started, across partial writes and rotation", () => {
        expect.assertions(4);

        const path = join(directory, "access.log");

        writeFileSync(path, "old-1\nold-2\n");

        const tailer = new LogTailer(path);

        expect(tailer.read()).toStrictEqual([]);

        appendFileSync(path, "new-1\nnew-");

        expect(tailer.read()).toStrictEqual(["new-1"]);

        appendFileSync(path, "2\n");

        expect(tailer.read()).toStrictEqual(["new-2"]);

        renameSync(path, join(directory, "access-1.log"));
        writeFileSync(path, "rotated-1\n");

        expect(tailer.read()).toStrictEqual(["rotated-1"]);
    });

    it("reads a log that did not exist yet from its first line", () => {
        expect.assertions(2);

        const path = join(directory, "late.log");
        const tailer = new LogTailer(path);

        expect(tailer.read()).toStrictEqual([]);

        writeFileSync(path, "first\nsecond\n");

        expect(tailer.read()).toStrictEqual(["first", "second"]);
    });
});
