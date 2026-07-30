import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Coverage floors below the repo default, because extraction moved code out
 * from under its tests rather than because the code is untested.
 *
 * Most of this package's 21 modules arrived from `@lunora/do`, where they were
 * exercised integration-style through `ShardDO`'s suite — 1134 tests that still
 * cover them today, but count toward `@lunora/do`'s coverage, not this
 * package's. Only the modules that already had standalone unit tests
 * (aggregate-sql, query-args, reactive-cache, rls-guard, socket-pool, where-sql,
 * geo) brought their coverage with them.
 *
 * These numbers are a RATCHET, not a target: they sit just under the current
 * measurement so a regression still fails, and every engine unit test added
 * should raise them toward the 80/70 default. Do not lower them.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 25, functions: 43, lines: 46, statements: 46 });
