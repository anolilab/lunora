import { describe, expect, it } from "vitest";

import type { QueryTimer } from "../src/query-timeout";
import { SqlQueryTimeoutError, withQueryTimeout } from "../src/query-timeout";
import type { SqlCtxExec } from "../src/sql-exec";

/** A timer whose deadlines fire only when the test says so. */
const manualTimer = (): { fireAll: () => void; timer: QueryTimer } => {
    const armed = new Set<() => void>();

    return {
        fireAll: () => {
            for (const fire of armed) {
                fire();
            }
        },
        timer: (fire) => {
            armed.add(fire);

            return () => {
                armed.delete(fire);
            };
        },
    };
};

/** An exec whose `transaction` waits for `checkout` (a pool handing out a connection), then runs `work` against `inner`. */
const slowCheckoutExec = (checkout: Promise<void>, inner: SqlCtxExec): SqlCtxExec => {
    return {
        all: async () => [],
        run: async () => {
            return { rowsAffected: 0 };
        },
        transaction: async (work) => {
            await checkout;

            return await work(inner);
        },
    };
};

describe(withQueryTimeout, () => {
    it("does not run a transaction's work once its deadline fired while waiting for a connection", async () => {
        expect.assertions(2);

        const { fireAll, timer } = manualTimer();
        const statements: string[] = [];
        let release: () => void = () => undefined;
        const checkout = new Promise<void>((resolve) => {
            release = resolve;
        });
        const inner: SqlCtxExec = {
            all: async () => [],
            run: async (query) => {
                statements.push(query);

                return { rowsAffected: 1 };
            },
        };
        const bounded = withQueryTimeout(slowCheckoutExec(checkout, inner), 100, timer);
        const outcome = (bounded.transaction as NonNullable<SqlCtxExec["transaction"]>)(async (tx) => {
            await tx.run("INSERT INTO t VALUES (1)", []);
        });

        fireAll();

        await expect(outcome).rejects.toBeInstanceOf(SqlQueryTimeoutError);

        // The connection frees up only now: the caller was told the write failed, so it must not run.
        release();
        await checkout;
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });

        expect(statements).toStrictEqual([]);
    });

    it("fails a statement issued after the transaction's deadline fired, so the driver rolls back", async () => {
        expect.assertions(2);

        const { fireAll, timer } = manualTimer();
        const statements: string[] = [];
        let proceed: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            proceed = resolve;
        });
        const inner: SqlCtxExec = {
            all: async () => [],
            run: async (query) => {
                statements.push(query);

                return { rowsAffected: 1 };
            },
        };
        let driverRolledBack = false;
        const exec: SqlCtxExec = {
            all: async () => [],
            run: async () => {
                return { rowsAffected: 0 };
            },
            transaction: async (work) => {
                try {
                    return await work(inner);
                } catch (error) {
                    driverRolledBack = true;

                    throw error;
                }
            },
        };
        const bounded = withQueryTimeout(exec, 100, timer);
        const outcome = (bounded.transaction as NonNullable<SqlCtxExec["transaction"]>)(async (tx) => {
            await tx.run("INSERT INTO t VALUES (1)", []);
            await gate;
            await tx.run("INSERT INTO t VALUES (2)", []);
        });

        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        fireAll();
        proceed();

        await expect(outcome).rejects.toBeInstanceOf(SqlQueryTimeoutError);

        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });

        expect({ driverRolledBack, statements }).toStrictEqual({ driverRolledBack: true, statements: ["INSERT INTO t VALUES (1)"] });
    });
});
