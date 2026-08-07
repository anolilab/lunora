/**
 * Node adapter: a `better-sqlite3`-backed `WorkflowStore` (`@visulima/workflow`),
 * so a Node workflow host survives a process restart.
 *
 * The engine ships `MemoryStore` (in-process `Map`s) and `SqlStore` (PostgreSQL
 * or MySQL over an async driver). Neither fits a Node host whose every other
 * durable surface — shard rows, KV, sockets, scheduler jobs — is already a
 * `better-sqlite3` table, so this is the third: the same six-method contract
 * over the same connection style as the rest of the package.
 *
 * Two tables, matching how `MemoryStore` keeps runs and leases apart: a lease
 * can be claimed for a run that does not exist yet (the engine acquires before
 * the first `save` of a `trigger`), so folding the lease into the run row would
 * make the very first activation fail to acquire.
 *
 * `acquire` is a single conditional upsert. That matters: the contract says a
 * lease is only race-free if the claim is atomic, and a read-check-write pair
 * would let two processes on one database file both believe they own the run.
 */

import type { StoredRun, WorkflowStore } from "@visulima/workflow";
import type Database from "better-sqlite3";

/** A persisted run row. `snapshot` is JSON text — the engine documents the snapshot as JSON-serialisable. */
interface RunRow {
    definition_id: string;
    event_name: string | null;
    run_id: string;
    snapshot: string;
    status: string;
    updated_at: number;
    wake_at: number | null;
}

/**
 * Build a durable {@link WorkflowStore} over a `better-sqlite3` connection.
 * Pass the result as `createNodeWorkflowHost({ store })`.
 */
export const createNodeWorkflowStore = (database: Database.Database): WorkflowStore => {
    database.exec(`CREATE TABLE IF NOT EXISTS _lunora_workflow_runs (
        run_id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        status TEXT NOT NULL,
        event_name TEXT,
        wake_at INTEGER,
        updated_at INTEGER NOT NULL,
        snapshot TEXT NOT NULL
    )`);
    database.exec("CREATE INDEX IF NOT EXISTS _lunora_workflow_runs_due ON _lunora_workflow_runs (wake_at)");
    database.exec("CREATE TABLE IF NOT EXISTS _lunora_workflow_leases (run_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)");

    const saveStatement = database.prepare<[string, string, string, string | null, number | null, number, string]>(
        `INSERT INTO _lunora_workflow_runs (run_id, definition_id, status, event_name, wake_at, updated_at, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET
             definition_id = excluded.definition_id,
             status = excluded.status,
             event_name = excluded.event_name,
             wake_at = excluded.wake_at,
             updated_at = excluded.updated_at,
             snapshot = excluded.snapshot`,
    );
    const loadStatement = database.prepare<[string], RunRow>("SELECT * FROM _lunora_workflow_runs WHERE run_id = ?");
    const deleteRunStatement = database.prepare<[string]>("DELETE FROM _lunora_workflow_runs WHERE run_id = ?");
    const deleteLeaseStatement = database.prepare<[string]>("DELETE FROM _lunora_workflow_leases WHERE run_id = ?");
    const dueStatement = database.prepare<[number, number], { run_id: string }>(
        `SELECT run_id FROM _lunora_workflow_runs
         WHERE status IN ('suspended', 'waiting') AND wake_at IS NOT NULL AND wake_at <= ?
         ORDER BY wake_at LIMIT ?`,
    );
    // One statement, so two processes on the same file cannot both win: the
    // conflicting UPDATE only fires when the current lease has expired or the
    // caller already holds it.
    const acquireStatement = database.prepare<[string, string, number, number]>(
        `INSERT INTO _lunora_workflow_leases (run_id, token, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
         WHERE _lunora_workflow_leases.expires_at <= ? OR _lunora_workflow_leases.token = excluded.token`,
    );
    const releaseStatement = database.prepare<[string, string]>("DELETE FROM _lunora_workflow_leases WHERE run_id = ? AND token = ?");

    return {
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async so a real store can await I/O; better-sqlite3 is synchronous
        acquire: async (runId, token, ttlMs) => {
            const now = Date.now();

            return acquireStatement.run(runId, token, now + ttlMs, now).changes > 0;
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `acquire`
        delete: async (runId) => {
            deleteRunStatement.run(runId);
            deleteLeaseStatement.run(runId);
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `acquire`
        due: async (now, limit) => dueStatement.all(now, limit).map((row) => row.run_id),
        // eslint-disable-next-line @typescript-eslint/require-await -- see `acquire`
        load: async (runId) => {
            const row = loadStatement.get(runId);

            if (row === undefined) {
                return undefined;
            }

            return {
                definitionId: row.definition_id,
                eventName: row.event_name ?? undefined,
                runId: row.run_id,
                snapshot: JSON.parse(row.snapshot) as unknown,
                status: row.status as StoredRun["status"],
                updatedAt: row.updated_at,
                wakeAt: row.wake_at ?? undefined,
            };
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `acquire`
        release: async (runId, token) => {
            releaseStatement.run(runId, token);
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `acquire`
        save: async (run) => {
            /* eslint-disable unicorn/no-null -- better-sqlite3 binds `null` to SQL NULL and rejects `undefined` outright */
            saveStatement.run(
                run.runId,
                run.definitionId,
                run.status,
                run.eventName ?? null,
                run.wakeAt ?? null,
                run.updatedAt,
                JSON.stringify(run.snapshot ?? null),
            );
            /* eslint-enable unicorn/no-null */
        },
    };
};
