import type { DatabaseSync } from "node:sqlite";

import type { DoStorageLike } from "../../src/do-store";

/**
 * A `DurableObjectStorage` double over `node:sqlite`, with real BEGIN/COMMIT.
 *
 * workerd forbids that SQL inside a real Durable Object (hence the platform's own
 * `state.storage.transaction` there), but the observable contract is the same:
 * atomic, and rolled back when the closure throws. The workerd suites cover the
 * genuine primitive; this exists so the Node suites can assert the adapter contract
 * on every run without booting a runtime.
 *
 * Shared by the suites rather than copied into each: an earlier duplicate pair is
 * exactly how the two would drift apart on the detail that matters (whether a throw
 * rolls back).
 */
const createDoStorage = (database: DatabaseSync): DoStorageLike => {
    return {
        sql: {
            exec: (query: string, ...bindings: unknown[]) => database.prepare(query).all(...(bindings as never[])),
        },
        transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
            database.exec("BEGIN");

            try {
                const result = await closure();

                database.exec("COMMIT");

                return result;
            } catch (error) {
                database.exec("ROLLBACK");

                throw error;
            }
        },
    };
};

export default createDoStorage;
