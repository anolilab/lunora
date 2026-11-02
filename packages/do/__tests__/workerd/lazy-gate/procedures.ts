interface SqlCursorLike {
    toArray: () => Record<string, unknown>[];
}

interface LazySql {
    exec: (query: string, ...bindings: unknown[]) => SqlCursorLike;
}

interface LazyModule {
    kind: "mutation" | "query" | "stream";
    run: (sql: LazySql, args: Record<string, unknown>) => unknown;
}

/** Module evaluations, keyed by module id. Lives as long as the isolate, like the generated loader's caches. */
const evaluations = new Map<string, number>();

const recordEvaluation = (moduleId: string): void => {
    evaluations.set(moduleId, (evaluations.get(moduleId) ?? 0) + 1);
};

const evaluationCount = (moduleId: string): number => evaluations.get(moduleId) ?? 0;

const readValue = (sql: LazySql, key: unknown): number => Number(sql.exec("SELECT value FROM lazy_counter WHERE key = ?", key).toArray()[0]?.value ?? 0);

/**
 * A read-modify-write mutation body. The read and the write straddle an await, as a real handler's `ctx.db` calls do,
 * so only the single-writer gate around it keeps two of them from reading the same value.
 */
const bump: LazyModule = {
    kind: "mutation",
    run: async (sql, { key, tag }) => {
        const value = readValue(sql, key) + 1;

        await Promise.resolve();

        sql.exec("INSERT INTO lazy_counter (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
        sql.exec("INSERT INTO lazy_log (key, tag) VALUES (?, ?)", key, tag);

        return { value };
    },
};

const read: LazyModule = {
    kind: "query",
    run: (sql, { key }) => {
        return { value: readValue(sql, key) };
    },
};

const tick: LazyModule = {
    kind: "stream",
    run: () =>
        (async function* ticks() {
            yield { tick: 1 };
            yield { tick: 2 };
        })(),
};

export type { LazyModule, LazySql };
export { bump, evaluationCount, read, recordEvaluation, tick };
