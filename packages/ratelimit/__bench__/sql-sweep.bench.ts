import { DatabaseSync } from "node:sqlite";

import { bench, describe } from "vitest";

import type { RateLimitConfigMap } from "../src/index";
import { createSqlStore, RateLimiter } from "../src/index";

/**
 * The SQL store's retention sweep against a real `node:sqlite`. Statements are
 * prepared once per text, as workerd's `SqlStorage` caches them, so the numbers
 * reflect statement count rather than re-parsing.
 *
 * - **backlog of 32** — a sweep that hits its bound: 32 expired rows per call.
 * - **steady churn** — every consume is a new key and expires roughly one old row.
 */

const createSql = () => {
    const database = new DatabaseSync(":memory:");
    const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

    return {
        exec: <Row = Record<string, unknown>>(query: string, ...params: unknown[]) => {
            let statement = cache.get(query);

            if (!statement) {
                statement = database.prepare(query);
                cache.set(query, statement);
            }

            const rows = statement.all(...(params as never[])) as Row[];

            return { toArray: () => rows };
        },
    };
};

const config = {
    hits: { kind: "fixed window", period: 1000, rate: 10 },
} satisfies RateLimitConfigMap<"hits">;

describe("sql store sweep", () => {
    const sql = createSql();
    const store = createSqlStore({ sql });
    let ts = 1;

    bench("backlog of 32 expired rows", async () => {
        for (let index = 0; index < 32; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential writes, as consumes land
            await store.set(`hits:k${String(ts)}-${String(index)}`, { ts, value: 1 });
        }

        await store.sweep?.(ts, 32, () => true);
        ts += 1;
    });

    let clock = 1_700_000_000_000;
    let key = 0;
    const limiter = new RateLimiter({ config, now: () => clock, store: createSqlStore({ sql: createSql() }) });

    bench("steady churn (new key per consume)", async () => {
        clock += 10;
        key += 1;
        await limiter.limit("hits", { key: String(key) });
    });
});
