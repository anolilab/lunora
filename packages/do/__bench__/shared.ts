import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * Shared bench fixtures (visulima `__bench__/shared.ts` convention).
 *
 * Build a fresh, isolated `ShardCtxDb` writer over an in-memory SQLite. Each
 * one-scenario-per-file bench owns its own writer via this factory — CodSpeed's
 * instrumented runner re-runs every bench body many times and would otherwise
 * let a fixture mutated by a sibling bench corrupt the measurement.
 */
// eslint-disable-next-line import/prefer-default-export -- shared bench-fixtures module; more named helpers join as benches migrate to the one-scenario-per-file layout.
export const makeWriter = (schema: SchemaLike): DatabaseWriterLike => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ schema, sql: harness.sql });
};
