import type { SqlExec } from "../../src/ctx-db";

/**
 * What a scenario under `../_scenarios/` needs from a SQLite: the engine's
 * `SqlExec`, a raw escape hatch for assertions, and a teardown. Both
 * `./node-sqlite.ts` (`node:sqlite`) and `../workerd/_helpers/do-sqlite.ts`
 * (a Durable Object's `state.storage.sql`) open one.
 */
export interface SqlHarness {
    close: () => void;
    raw: (query: string, ...params: unknown[]) => Record<string, unknown>[];
    sql: SqlExec;
}
