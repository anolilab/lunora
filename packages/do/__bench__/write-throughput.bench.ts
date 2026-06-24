import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";
import type { AggregateIndexDefinitionLike } from "../src/aggregates";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { RankIndexDefinitionLike } from "../src/rank";

/**
 * Foundational write baseline: how fast can we `insert`/`patch`/`replace`/
 * `delete` against a JSON-blob DO-SQLite table? The trigger-overhead,
 * aggregateIndex, and rankIndex maintenance benches all ride on this floor.
 *
 * - **bare** — no triggers, no aggregateIndex, no rankIndex.
 * The "what's the SQL write actually cost?" reading.
 * - **+ aggregateIndex** — same writes against a schema with `byProject`.
 * Counter companion update fires per insert/patch/delete.
 * - **+ rankIndex** — same writes against a schema with `byChannel`.
 * Rank companion table update fires per insert/patch/delete.
 *
 * Subtract `bare` from the indexed variants to see what each maintenance
 * path costs.
 */

const byProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

const byChannel: RankIndexDefinitionLike = {
    name: "byChannel",
    on: "todos",
    partitionBy: ["projectId"],
    sortBy: [{ direction: "asc", field: "seq" }],
};

const baseSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: { projectId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const aggSchema: SchemaLike = {
    tables: {
        todos: {
            aggregateIndexes: [byProject],
            indexes: [],
            shape: { projectId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const rankSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            rankIndexes: [byChannel],
            shape: { projectId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const makeWriter = (schema: SchemaLike): DatabaseWriterLike => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ schema, sql: harness.sql });
};

const bareWriter = makeWriter(baseSchema);
const aggWriter = makeWriter(aggSchema);
const rankWriter = makeWriter(rankSchema);

// Seed a row per writer so patch/replace/delete have something to operate
// on. Each bench iteration uses a fresh id so they don't collide.
let bareCounter = 0;
let aggCounter = 0;
let rankCounter = 0;

const seedId = "seed";

// The patch/replace target must exist before those benches run. `beforeAll`
// covers the plain `vitest bench` runner, but CodSpeed's instrumented analysis
// pass calibrates each bench body WITHOUT running the suite `beforeAll`, leaving
// the row absent ("document not found: seed"). Seed defensively through a guard
// that is idempotent: the flag makes it a no-op after the first call (so it
// never double-inserts when `beforeAll` already ran), and the one-off insert
// lands in tinybench's discarded warmup iterations, not the measured ones.
const ensureBareSeed = async () => {
    // DB-checked, not a module flag: CodSpeed's instrumented runner measures each
    // bench body without the suite `beforeAll` seed, and a stale boolean flag (set
    // before the await) would latch true while the row is absent — the source of
    // "document not found: seed". `get` is a cheap PK lookup; insert only if gone.
    if (await bareWriter.get(seedId, "todos")) {
        return;
    }

    await bareWriter.insert("todos", { _id: seedId, projectId: "p1", seq: 1 });
};

describe("write throughput — insert/patch/replace/delete", () => {
    beforeAll(ensureBareSeed);

    bench("bare: insert (no triggers, no indexes)", async () => {
        bareCounter += 1;
        await bareWriter.insert("todos", { _id: `b${String(bareCounter)}`, projectId: "p1", seq: bareCounter });
    });

    bench("+ aggregateIndex: insert (counter companion updates inline)", async () => {
        aggCounter += 1;
        await aggWriter.insert("todos", { _id: `a${String(aggCounter)}`, projectId: "p1", seq: aggCounter });
    });

    bench("+ rankIndex: insert (rank companion + sort-key index updates inline)", async () => {
        rankCounter += 1;
        await rankWriter.insert("todos", { _id: `r${String(rankCounter)}`, projectId: "p1", seq: rankCounter });
    });

    bench("bare: patch (single-field update on seed row)", async () => {
        await ensureBareSeed();
        await bareWriter.patch(seedId, { seq: bareCounter });
    });

    bench("bare: replace (full-row substitute on seed row)", async () => {
        await ensureBareSeed();
        await bareWriter.replace(seedId, { _id: seedId, projectId: "p1", seq: bareCounter });
    });
});
