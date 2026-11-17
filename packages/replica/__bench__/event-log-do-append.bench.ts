import { DatabaseSync } from "node:sqlite";

import { bench, describe } from "vitest";

import { signedRequest, TEST_ENV, TEST_INSTANCE } from "../__tests__/_helpers/signed-request";
import { EventLogDO } from "../src/event-log-do";

/*
 * `/append` runs per materializer write. Each event costs SQL statements inside
 * the batch's transaction, so a batch's cost should grow by one INSERT per event
 * and nothing else. Real SQLite (`node:sqlite`) with cached prepared statements,
 * as workerd caches them; the signature and fingerprint are part of the measured
 * request because they are part of every real one.
 */

const database = new DatabaseSync(":memory:");
const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

const exec = (query: string, ...params: unknown[]): { toArray: () => unknown[] } => {
    let statement = statements.get(query);

    if (statement === undefined) {
        statement = database.prepare(query);
        statements.set(query, statement);
    }

    const rows = statement.all(...(params as never[]));

    return { toArray: () => rows };
};

const eventLog = new EventLogDO({ id: { toString: () => TEST_INSTANCE }, storage: { sql: { exec } } }, TEST_ENV);

const BATCH_SIZE = 100;
let batch = 0;

describe(`EventLogDO /append (${String(BATCH_SIZE)} events per batch)`, () => {
    bench("append", async () => {
        batch += 1;

        const events = Array.from({ length: BATCH_SIZE }, (_, index) => {
            return { payload: { batch, index, note: "hello" }, type: "tick" };
        });
        const response = await eventLog.fetch(await signedRequest("POST", "https://log/append", JSON.stringify({ batchId: `b${String(batch)}`, events })));

        if (response.status !== 200) {
            throw new Error(`append failed: ${String(response.status)}`);
        }
    });
});
