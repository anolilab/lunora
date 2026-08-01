import type { SqlExec } from "@lunora/shard-engine";

import type createSqliteExec from "./node-sqlite";

/**
 * A brand-new `SqlExec` object bound to the SAME underlying storage as
 * `harness` — simulating a fresh isolate reattaching to a durable shard after
 * hibernation. Object identity differs from `harness.sql`, so any
 * `WeakSet`/`WeakMap` memoization keyed on the handle starts cold, while the
 * SQL it runs lands in the same tables `harness.sql` already wrote.
 */
const freshHandleOver = (harness: ReturnType<typeof createSqliteExec>): SqlExec =>
    ({
        exec: (query: string, ...parameters: unknown[]) => {
            const rows = harness.raw(query, ...parameters);

            return {
                one: () => {
                    if (rows.length !== 1) {
                        throw new Error(`expected exactly one row, received ${String(rows.length)}`);
                    }

                    return rows[0]!;
                },
                [Symbol.iterator]: () => rows[Symbol.iterator](),
                toArray: () => rows,
            };
        },
    }) as unknown as SqlExec;

export default freshHandleOver;
