import type Database from "better-sqlite3";

/**
 * Most compiled statements kept per connection. Callers bind values as
 * parameters, so the distinct-SQL set is bounded by an app's query shapes; the
 * cap only protects against a dynamic builder that emits unbounded shapes.
 */
const MAX_CACHED_STATEMENTS = 2000;

/**
 * Per-connection LRU of compiled statements keyed by SQL text.
 * `database.prepare(sql)` recompiles on every call; the `WeakMap` key keeps the
 * cache from pinning a closed connection. better-sqlite3 re-prepares a reused
 * statement itself after a schema change.
 */
const statementCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

const preparedStatement = (database: Database.Database, sql: string): Database.Statement => {
    let cache = statementCache.get(database);

    if (cache === undefined) {
        cache = new Map();
        statementCache.set(database, cache);
    }

    let prepared = cache.get(sql);

    if (prepared === undefined) {
        prepared = database.prepare(sql);

        if (cache.size >= MAX_CACHED_STATEMENTS) {
            cache.delete(cache.keys().next().value as string);
        }
    } else {
        cache.delete(sql);
    }

    // Re-insert so Map order is recency order: the first key is the eviction victim.
    cache.set(sql, prepared);

    return prepared;
};

export default preparedStatement;
