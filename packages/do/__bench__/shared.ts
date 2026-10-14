import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";
import type { ShardDOState } from "../src/shard-do";

/**
 * Shared bench fixtures (visulima `__bench__/shared.ts` convention).
 *
 * Each one-scenario-per-file bench owns its own writer/state via these
 * factories — CodSpeed's instrumented runner re-runs every bench body many times
 * and would otherwise let a fixture mutated by a sibling bench corrupt the
 * measurement.
 */

/** A `SqlExec` as `createShardCtxDb` takes it — the one place the harness's handle is named. */
type BenchSql = Parameters<typeof createShardContextDatabase>[0]["sql"];

/** Build a fresh, isolated `ShardCtxDb` writer over an in-memory SQLite. */
const makeWriter = (schema: SchemaLike): DatabaseWriterLike => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ schema, sql: harness.sql });
};

/**
 * A CDC-enabled shard fixture: migrated SQLite, a writer over it, and the
 * `ShardDOState` a `ShardDO` subclass needs.
 *
 * `sockets` is the live list a bench pushes its fakes into — `getWebSockets`
 * returns it by reference, so a bench can add subscribers after construction.
 * The state carries a name because several tiers (the relay role, the sibling
 * channel) resolve their role from it and behave differently unnamed.
 */
const makeCdcShardFixture = (schema: SchemaLike, sockets: unknown[] = []): { sql: BenchSql; state: ShardDOState; writer: DatabaseWriterLike } => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema, { cdc: true });

    const writer = createShardContextDatabase({
        broadcast: () => undefined,
        cdc: true,
        clock: () => 1_700_000_000_000,
        schema,
        sql: harness.sql,
    });

    const state = {
        acceptWebSocket(ws: unknown) {
            sockets.push(ws);
        },
        getWebSockets() {
            return sockets;
        },
        id: { name: "bench-shard" },
        // No `waitUntil`: a flush (and with it any poke fan-out) is awaited
        // inline, so one `fetch` measures one complete pass.
        storage: { sql: harness.sql },
    } as unknown as ShardDOState;

    return { sql: harness.sql, state, writer };
};

export { makeCdcShardFixture, makeWriter };
export type { BenchSql };
