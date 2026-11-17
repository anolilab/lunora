import { LunoraError } from "@lunora/errors";

import type { SqlCtxExec as SqlContextExec } from "./sql-exec";

/** Arm a timer that calls `fire` after `ms`, returning the function that disarms it. Injectable so tests fire it by hand. */
type QueryTimer = (fire: () => void, ms: number) => () => void;

/** The bound a `.global()` statement gets when the host names none: past it, the dispatch waiting on it is released. */
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

const defaultQueryTimer: QueryTimer = (fire, ms) => {
    const handle = setTimeout(fire, ms);

    return () => {
        clearTimeout(handle);
    };
};

/**
 * A `.global()` statement outlived its deadline and was abandoned. `503` and retryable, as an upstream that did not
 * answer is. The engine may still run it, so a write that timed out may or may not have applied, and the store
 * never retries one itself.
 */
class SqlQueryTimeoutError extends LunoraError {
    public readonly timeoutMs: number;

    public constructor(timeoutMs: number) {
        super(
            "SERVICE_UNAVAILABLE",
            `the .global() database did not answer within ${String(timeoutMs)}ms; the statement was abandoned and, if it was a write, may or may not have applied`,
            { internal: { timeoutMs }, name: "SqlQueryTimeoutError" },
        );
        this.timeoutMs = timeoutMs;
    }
}

/** The driver call each timeout abandoned, so a caller can act on how it really settled. */
const abandoned = new WeakMap<SqlQueryTimeoutError, Promise<unknown>>();

/** The still-running work `error` abandoned, if it is a {@link SqlQueryTimeoutError} from {@link withQueryTimeout}. */
const abandonedWork = (error: unknown): Promise<unknown> | undefined => (error instanceof SqlQueryTimeoutError ? abandoned.get(error) : undefined);

/** `exec` with `assertLive` run before each statement, so a transaction that has expired issues nothing more. */
const untilExpired = (exec: SqlContextExec, assertLive: () => void): SqlContextExec => {
    return {
        all: async (sql, parameters) => {
            assertLive();

            return await exec.all(sql, parameters);
        },
        ...(exec.batch === undefined
            ? {}
            : {
                  batch: async (statements) => {
                      assertLive();
                      await exec.batch?.(statements);
                  },
              }),
        run: async (sql, parameters) => {
            assertLive();

            return await exec.run(sql, parameters);
        },
    };
};

/**
 * Bound every statement `exec` runs by `timeoutMs`. A `Promise.race`, not a cancellation: the driver's call keeps
 * running, but the dispatch awaiting it is released with a {@link SqlQueryTimeoutError}. A non-finite or
 * non-positive `timeoutMs` leaves `exec` unbounded.
 */
const withQueryTimeout = (exec: SqlContextExec, timeoutMs: number, timer: QueryTimer = defaultQueryTimer): SqlContextExec => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return exec;
    }

    const bounded = async <T>(work: Promise<T>, onFire?: () => void): Promise<T> => {
        let disarm: (() => void) | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            disarm = timer(() => {
                const error = new SqlQueryTimeoutError(timeoutMs);

                abandoned.set(error, work);
                onFire?.();
                reject(error);
            }, timeoutMs);
        });

        try {
            // The race subscribes to `work`, so a rejection after the deadline won is not left unhandled.
            return await Promise.race([work, deadline]);
        } finally {
            disarm?.();
        }
    };

    return {
        all: async (sql, parameters) => await bounded(exec.all(sql, parameters)),
        ...(exec.batch === undefined
            ? {}
            : {
                  batch: async (statements) => {
                      await bounded(exec.batch?.(statements) ?? Promise.resolve());
                  },
              }),
        run: async (sql, parameters) => await bounded(exec.run(sql, parameters)),
        // Each statement inside is bounded so a hung one rejects `work` and the driver rolls back instead of
        // committing late. The whole call is bounded too: connection checkout, BEGIN, COMMIT and the ROLLBACK queued
        // behind a hung statement on the same connection would otherwise hold the caller with no deadline.
        // Once that outer deadline fired the caller has been told the write failed, so `work` must not start (a
        // connection that frees up late) and must not commit (a statement still in flight): every entry into it, and
        // its return, throws instead, and the driver rolls the transaction back.
        ...(exec.transaction === undefined
            ? {}
            : {
                  transaction: async <T>(work: (tx: SqlContextExec) => Promise<T>): Promise<T> => {
                      let expired = false;
                      const assertLive = (): void => {
                          if (expired) {
                              throw new SqlQueryTimeoutError(timeoutMs);
                          }
                      };

                      return await bounded(
                          (exec.transaction as NonNullable<SqlContextExec["transaction"]>)(async (tx) => {
                              assertLive();

                              const result = await work(untilExpired(withQueryTimeout(tx, timeoutMs, timer), assertLive));

                              assertLive();

                              return result;
                          }),
                          () => {
                              expired = true;
                          },
                      );
                  },
              }),
    };
};

export type { QueryTimer };
export { abandonedWork, DEFAULT_QUERY_TIMEOUT_MS, SqlQueryTimeoutError, withQueryTimeout };
