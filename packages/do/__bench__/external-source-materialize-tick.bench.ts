import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";
import { diffExternalSource } from "../src/external-source-diff";

/**
 * Plan 077 Phase 0 gate (design shipped in PR #80 `d5cf9151e`; §9 in git history): the DO-side
 * per-tick cost of the **full-pull** external-source materialize loop, the path
 * a sourced table runs on every poll alarm.
 *
 * A steady-state tick is `read local membership → diff vs the freshly-pulled
 * source membership → apply the delta`. This file measures the first two —
 * **read + diff** — which is the work every tick pays even when nothing changed
 * (the common case), so it is what the poll cadence multiplies. The third step
 * (apply) is priced separately in `external-source-apply.bench.ts`; the apply is
 * skipped here entirely, so these benches are non-mutating and re-run-safe under
 * CodSpeed's repeated-body runner.
 *
 * **Deliberately excluded: the Hyperdrive network read.** That is an external
 * round-trip, not DO-isolate CPU, and is not locally benchmarkable — it must be
 * measured separately against a real binding. What sets the full-pull row cap +
 * cadence floor is the CPU/IO measured here: how expensive is it to re-read S
 * rows (a full table scan, the local membership) and diff them every tick.
 *
 * Two readings per size. `pure diff` isolates the JS diff loop (it scans full
 * membership, O(S), regardless of churn). `read + diff` adds the full-scan +
 * decode the real tick pays, so the gap between the two is the local-read overhead.
 */

const SIZES = [10, 100, 1000, 10_000] as const;

/** A representative document payload — body large enough that JSON serialization (the diff's per-row cost) is realistic, not a toy. */
const BODY = "x".repeat(200);

/**
 * A sourced + `.shardBy("orgId")` table: one DO holds one tenant's slice. No
 * secondary indexes — index/trigger maintenance is already priced by the
 * `write-throughput-*` benches; this isolates the materialize loop's own cost.
 */
const schema: SchemaLike = {
    tables: {
        documents: {
            indexes: [],
            shape: { body: { kind: "string" }, orgId: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/** The shape both sides of the diff are compared in: the source row and the local row mapped to the same projected document (design §3.3). */
const canonical = (id: string, stored: Record<string, unknown>): Record<string, unknown> => {
    return { _id: id, body: stored.body, orgId: stored.orgId, title: stored.title };
};

const seed = async (writer: DatabaseWriterLike, rows: number): Promise<void> => {
    for (let index = 0; index < rows; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed, single-threaded SQLite
        await writer.insert("documents", { body: BODY, orgId: "org_1", title: `Doc ${String(index)}` });
    }
};

/** Full-scan the materialized table to the canonical pulled membership — the "read local membership" the real tick performs each poll. */
const readMembership = (harness: ReturnType<typeof createSqliteExec>): Record<string, unknown>[] =>
    harness.sql
        .exec("SELECT id, __doc__ FROM documents")
        .toArray()
        .map((row) => {
            const { __doc__, id } = row as { __doc__: string; id: string };

            return canonical(id, JSON.parse(__doc__) as Record<string, unknown>);
        });

const harnesses = new Map<number, ReturnType<typeof createSqliteExec>>();
/** The "Hyperdrive returned these" set, captured once per size as the canonical pulled membership. */
const pulledBySize = new Map<number, Record<string, unknown>[]>();
/** Precomputed baseline (`id → canonical json`) for the pure-diff reading, so its body measures only the diff. */
const baselineBySize = new Map<number, Map<string, string>>();

describe("external-source materialize tick (full-pull read + diff)", () => {
    beforeAll(async () => {
        for (const size of SIZES) {
            const harness = createSqliteExec();

            runShardMigrations(harness.sql, schema);

            const writer = createShardContextDatabase({ schema, sql: harness.sql });

            // eslint-disable-next-line no-await-in-loop -- one-time per-size fixture seed; sizes are independent
            await seed(writer, size);

            const pulled = readMembership(harness);
            const baseline = new Map(pulled.map((entry) => [String(entry._id), JSON.stringify(entry)]));

            harnesses.set(size, harness);
            pulledBySize.set(size, pulled);
            baselineBySize.set(size, baseline);
        }
    });

    for (const size of SIZES) {
        bench(`pure diff (unchanged) — ${String(size)} rows`, () => {
            // Steady state: pulled equals the baseline, so the diff scans S rows and emits zero ops — the recurring no-op cost.
            diffExternalSource(pulledBySize.get(size)!, baselineBySize.get(size)!, { table: "documents" });
        });
    }

    for (const size of SIZES) {
        bench(`read local + diff (unchanged) — ${String(size)} rows`, () => {
            const local = readMembership(harnesses.get(size)!);
            const baseline = new Map(local.map((entry) => [String(entry._id), JSON.stringify(entry)]));

            diffExternalSource(pulledBySize.get(size)!, baseline, { table: "documents" });
        });
    }
});
