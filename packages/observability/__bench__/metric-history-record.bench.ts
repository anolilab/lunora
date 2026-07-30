import { bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";
import { recordMetricHistory } from "../src/metric-history";

/**
 * The hot path: `recordMetricHistory` on a repeated `(series, minute)` bucket — a
 * metrics-heavy handler (or a per-recipient broadcast) recording the same series
 * many times in a minute. Every call is a durable upsert regardless; this bench
 * measures the read/DDL overhead AROUND that upsert, which the per-handle table-
 * ensured memo and the known-bucket set exist to strip on the repeat.
 *
 * A fixed `ts` keeps every measurement in one minute bucket (the repeat path); the
 * harness is warmed once so the body measures steady state, not first-write setup.
 */
const event = {
    attributes: { channel: "push", provider: "web-push", status: "accepted" },
    functionPath: "notify:broadcast",
    kind: "counter" as const,
    name: "notify.send",
    shardKey: "shard-1",
    ts: 1_700_000_000_000,
    value: 1,
};

describe("recordMetricHistory — hot in-minute repeat", () => {
    const harness = createSqliteExec();

    // Warm: create the series + its bucket so the body measures the repeat, not
    // the one-time table-create + first-insert + cap-scan + trim.
    recordMetricHistory(harness.sql, event);

    bench("repeated same-(series, bucket) measurement", () => {
        recordMetricHistory(harness.sql, event);
    });
});
