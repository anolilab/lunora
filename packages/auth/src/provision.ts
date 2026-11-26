import type { SqlExecutor } from "./sql-store";

/** The binding each `d1Executor` wraps: better-auth keys a database's schema verdict on it. */
const executorDatabases = new WeakMap<SqlExecutor, object>();

/** The D1 binding behind an executor `d1Executor` built, if it built this one. */
const executorDatabase = (executor: SqlExecutor): object | undefined => executorDatabases.get(executor);

/** Called by `d1Executor` for each executor it builds. */
const recordExecutorDatabase = (executor: SqlExecutor, database: object): void => {
    executorDatabases.set(executor, database);
};

/** The provisioning run per executor: in flight or done. A rejected one is evicted so the next statement retries it. */
const provisioned = new WeakMap<SqlExecutor, Promise<void>>();

/**
 * Run `provision` over `executor` once per isolate, sharing the run with concurrent callers. A failure is
 * not kept: the caller sees it, and the next call provisions again, so a transient error does not stick
 * for the life of the isolate. The first `provision` given for an executor is the one that runs.
 */
const provisionOnce = async (executor: SqlExecutor, provision: (executor: SqlExecutor) => Promise<void>): Promise<void> => {
    let run = provisioned.get(executor);

    if (run === undefined) {
        run = provision(executor);
        provisioned.set(executor, run);
        run.catch(() => provisioned.delete(executor));
    }

    await run;
};

/**
 * `executor`, with every statement held until `provision` has run over it ({@link provisionOnce}). The
 * provisioning itself runs over the unwrapped executor, so it cannot wait on itself.
 */
const provisionedExecutor = (executor: SqlExecutor, provision: (executor: SqlExecutor) => Promise<void>): SqlExecutor => {
    const ready = async (): Promise<void> => provisionOnce(executor, provision);
    return {
        all: async (sql, parameters) => {
            await ready();

            return executor.all(sql, parameters);
        },
        ...(executor.batch === undefined
            ? {}
            : {
                  batch: async (statements: ReadonlyArray<{ params: ReadonlyArray<unknown>; sql: string }>): Promise<void> => {
                      await ready();
                      await executor.batch?.(statements);
                  },
              }),
        run: async (sql, parameters) => {
            await ready();
            await executor.run(sql, parameters);
        },
    };
};

export { executorDatabase, provisionedExecutor, provisionOnce, recordExecutorDatabase };
