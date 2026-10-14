import { bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";
import { createMetrics } from "../src/context-telemetry";
import { recordMetricHistory } from "../src/metric-history";

/**
 * Prices one `ctx.metrics.count(...)` call in two layers, because a metric point
 * does more than a buffer push.
 *
 * Layer 1, CPU only — `createMetrics` with a no-op `record`. Measures the emit
 * path itself: the finite check, `normalizeLogFields` over the attributes, and
 * the event-object construction. This is the floor every metric call pays.
 *
 * Layer 2, durable — `record` routed through `recordMetricHistory` against an
 * in-memory SQLite, the real per-call cost in `ShardDOBase.recordMetric`: a
 * tracked/cardinality-cap SELECT, an `INSERT … ON CONFLICT … DO UPDATE` upsert,
 * and a bounded `DELETE` — per call.
 *
 * The gap between the two is the headline number: because `notify.send` (and any
 * `ctx.metrics.count`) emits per recipient, a broadcast over N subscriptions pays
 * the durable cost N times. If layer 2 dominates, aggregating a broadcast's
 * per-status counts into ≤3 emits (accepted/failed/gone) is the win to chase.
 */
const attrs3 = { channel: "push", provider: "web-push", status: "accepted" };
const attrsNested = { detail: { code: 410 }, status: "gone" };

describe("ctx.metrics.count — CPU only (no-op record)", () => {
    const noop = createMetrics({ functionPath: "notify:broadcast", record: () => undefined, shardKey: "shard-1" });

    bench("count, no attributes", () => {
        noop.count("notify.send", 1);
    });

    bench("count, 3 primitive attributes", () => {
        noop.count("notify.send", 1, attrs3);
    });

    bench("count, nested-object attribute (JSON-encode path)", () => {
        noop.count("notify.send", 1, attrsNested);
    });
});

describe("ctx.metrics.count — durable (recordMetricHistory upsert)", () => {
    // One warm harness shared across iterations: the table is created once (lazy,
    // on first record) and every `count` upserts the SAME per-minute series row,
    // which is exactly a broadcast's pattern (many sends, one series, one minute).
    // So the body measures the steady-state per-call cost — select + upsert +
    // prune — not the one-time setup.
    const harness = createSqliteExec();
    const metrics = createMetrics({
        functionPath: "notify:broadcast",
        record: (event) => {
            recordMetricHistory(harness.sql, event);
        },
        shardKey: "shard-1",
    });

    bench("count, 3 attributes → SQLite select + upsert + prune", () => {
        metrics.count("notify.send", 1, attrs3);
    });
});
