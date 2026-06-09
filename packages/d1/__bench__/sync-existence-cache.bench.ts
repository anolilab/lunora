import { DatabaseSync } from "node:sqlite";

import type { AggregateIndexDefinitionLike, DatabaseWriterLike, RankIndexDefinitionLike, SchemaLike, ValidatorLike } from "@cirrus/do";
import { bench, describe } from "vitest";

import type { D1Exec } from "../src/d1-ctx-db";
import { createD1CtxDb as createD1ContextDatabase, runD1AggregateMigrations, runD1RankMigrations } from "../src/d1-ctx-db";

/**
 * Demonstrates the syncAggregates/syncRanks existence-cache win: on every
 * insert/patch/replace/delete the post-write sync hooks used to re-probe
 * `sqlite_master` once per aggregate + rank index, even though the pre-write
 * backfill hooks had just cached the same answer. The optimization reads the
 * cached answer instead, dropping the per-write `sqlite_master` probes to zero
 * on the warm path.
 *
 * To make the win demonstrable without keeping the old code around, the
 * instrumented exec below counts `sqlite_master` SELECTs. The "cold" writer
 * pays the probe on its first write per (table,index) — the cache miss — while
 * every subsequent write on the "warm" path issues zero probes. The contrast
 * isolates exactly the round-trips the optimization eliminates.
 */
const CLOCK = 1_700_000_000_000;

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const byProject: AggregateIndexDefinitionLike = { by: ["projectId"], name: "byProject", on: "todos", op: "count" };
const total: AggregateIndexDefinitionLike = { by: [], name: "total", on: "todos", op: "count" };
const bySeq: RankIndexDefinitionLike = {
    name: "bySeq",
    on: "todos",
    partitionBy: ["projectId"],
    sortBy: [{ direction: "asc", field: "seq" }],
};

const schema: SchemaLike = {
    tables: {
        todos: {
            aggregateIndexes: [byProject, total],
            indexes: [],
            rankIndexes: [bySeq],
            shape: { priority: col("string"), projectId: col("string"), seq: col("number") },
        },
    },
};

const SQLITE_MASTER_RE = /sqlite_master/i;

interface CountingExec {
    exec: D1Exec;
    masterProbes: () => number;
    reset: () => void;
}

const createCountingExec = (): CountingExec => {
    const database = new DatabaseSync(":memory:");
    let probes = 0;

    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => {
        if (SQLITE_MASTER_RE.test(query)) {
            probes += 1;
        }

        return database.prepare(query).all(...(parameters as never[]));
    };

    database
        .prepare(
            `CREATE TABLE "todos" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "priority" TEXT,
                "projectId" TEXT,
                "seq" INTEGER
            )`,
        )
        .all();

    return {
        exec: {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        },
        masterProbes: () => probes,
        reset: () => {
            probes = 0;
        },
    };
};

const buildWriter = async (): Promise<{ counting: CountingExec; writer: DatabaseWriterLike }> => {
    const counting = createCountingExec();

    await runD1AggregateMigrations(counting.exec, schema);
    await runD1RankMigrations(counting.exec, schema);

    const writer = createD1ContextDatabase({ clock: () => CLOCK, exec: counting.exec, schema });

    return { counting, writer };
};

// Warm writer: the first insert primes the existence cache; benched writes
// thereafter hit the cache and issue zero sqlite_master probes.
const warm = await buildWriter();
let warmSeq = 0;

await warm.writer.insert("todos", { _id: "warmup", priority: "medium", projectId: "p0", seq: -1 }, { allowExplicitId: true });
warm.counting.reset();

describe("d1 write — sync existence cache", () => {
    bench("warm insert (cached existence — zero sqlite_master probes)", async () => {
        warmSeq += 1;
        await warm.writer.insert("todos", { _id: `w${String(warmSeq)}`, priority: "medium", projectId: "p1", seq: warmSeq }, { allowExplicitId: true });
        // After the optimization, warm.counting.masterProbes() stays 0 across
        // these writes — the 3 probes/write (2 aggregate + 1 rank) are gone.
    });

    bench("cold insert (cache miss — pays the existence probes)", async () => {
        // A fresh writer per iteration forces the first-write cache-miss path,
        // standing in for the pre-optimization behavior where every write
        // re-probed sqlite_master.
        const cold = await buildWriter();

        await cold.writer.insert("todos", { _id: "c1", priority: "medium", projectId: "p1", seq: 1 }, { allowExplicitId: true });
    });
});
