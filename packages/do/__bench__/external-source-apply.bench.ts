import type { CdcChange, DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { applyCdcChanges, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * Plan 077 Phase 0 gate (design shipped in PR #80 `d5cf9151e`; §9 in git history): the cost of the
 * **apply** step of the external-source materialize loop — landing a batch of
 * pulled rows into the DO's SQLite through `applyCdcChanges`, the single legitimate
 * ingress for external data (design §1, Fact B).
 *
 * This prices the per-tick **write budget**: how many changed rows a single DO
 * isolate can materialize per tick. It is the dominant cost (the read+diff is
 * priced in `external-source-materialize-tick.bench.ts`) and scales with the
 * number of *changed* rows, not total membership — so a steady source with little
 * churn pays mostly the read+diff, while a first pull or a high-churn tick pays
 * this.
 *
 * `cdc: true` so the `__cdc_log` post-image append is included: that append is
 * what makes the materialized rows live-pokeable to `defineShape` subscribers, so
 * it is part of the real ingress cost, not optional overhead.
 *
 * Each body applies `BATCH` brand-new rows (fresh ids via a monotonic counter, the
 * `write-throughput-insert-bare` precedent) so CodSpeed's repeated-body runner
 * never replays the same id — this measures the **insert** apply path (new rows).
 * The update path (insert→ConflictError→replace fallback in `applyCdcChange`) is
 * already priced by the existing `write-throughput` patch/replace benches.
 *
 * Per-row apply cost = (bench body time) / BATCH.
 */

const BATCH = 100;

const BODY = "x".repeat(200);

const schema: SchemaLike = {
    tables: {
        documents: {
            indexes: [],
            shape: { body: { kind: "string" }, orgId: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

let writer: DatabaseWriterLike;
let batchBase = 0;

describe("external-source apply (applyCdcChanges ingress)", () => {
    beforeAll(() => {
        const harness = createSqliteExec();

        runShardMigrations(harness.sql, schema, { cdc: true });

        writer = createShardContextDatabase({ broadcast: () => undefined, cdc: true, clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    bench(`apply ${String(BATCH)} fresh upserts (insert path, cdc append)`, async () => {
        batchBase += 1;

        const changes: CdcChange[] = [];

        for (let index = 0; index < BATCH; index += 1) {
            const id = `d${String(batchBase)}_${String(index)}`;

            changes.push({ doc: { _id: id, body: BODY, orgId: "org_1", title: `Doc ${id}` }, id, op: "insert", seq: 0, table: "documents", ts: 0 });
        }

        await applyCdcChanges(writer, changes);
    });
});
