// Test fixture, intentionally duplicated with `@lunora/shard-engine`'s copy, for
// the reason `../../_helpers/node-sqlite.ts` gives in that package.
import type { SqlExec } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import type { aroundEach } from "vitest";

import type { SqlHarness } from "../../_helpers/sql-harness";

let storage: SqlExec | undefined;

/** Bounds the whole wrapped run (hooks + body), as `@lunora/shard-engine`'s twin of this file does. */
const FRESH_DO_TIMEOUT = 180_000;

/**
 * An `aroundEach` listener (register it with {@link FRESH_DO_TIMEOUT}) that runs
 * each test, its `beforeEach`/`afterEach` hooks included, inside a fresh
 * SQLite-backed Durable Object.
 *
 * It has to be the whole test, not a handle carried out of `runInDurableObject`:
 * workerd refuses `state.storage.sql` from any context but the object's own
 * ("Cannot perform I/O on behalf of a different Durable Object"), and the engine
 * calls `exec` synchronously, so it cannot hop back in per statement either.
 * A unique id per test gives every test an empty database, as `:memory:` does.
 */
const inFreshDurableObject: Parameters<typeof aroundEach>[0] = async (runTest) => {
    const stub = env.SQLITE.get(env.SQLITE.newUniqueId());

    await runInDurableObject(stub, async (_instance, state) => {
        storage = state.storage.sql as unknown as SqlExec;

        try {
            await runTest();
        } finally {
            storage = undefined;
        }
    });
};

/**
 * The workerd twin of `../../_helpers/node-sqlite.ts`: same `{ close, raw, sql }`
 * shape, so a scenario under `__tests__/_scenarios/` runs unchanged on either.
 *
 * `sql` is the current test's Durable Object `state.storage.sql` — the handle
 * `ShardDO` passes the engine (`this.state.storage.sql as unknown as SqlExec`),
 * with no adapter between. Only callable under {@link inFreshDurableObject}.
 */
const createWorkerdExec = (): SqlHarness => {
    const sql = storage;

    if (sql === undefined) {
        throw new Error("createWorkerdExec() called outside inFreshDurableObject()");
    }

    return {
        close: () => {},
        raw: (query, ...params) => sql.exec(query, ...params).toArray(),
        sql,
    };
};

export { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject };
