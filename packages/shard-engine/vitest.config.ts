import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * These numbers are a RATCHET, not a target: they sit just under the current
 * measurement (89.0 stmts / 79.5 branches / 88.1 funcs / 89.0 lines, with
 * ~1-2pp of slack for the v8-instrumentation variance between Node versions)
 * so a regression still fails, and every engine unit test added should raise
 * them. Do not lower them.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 78, functions: 86, lines: 87, statements: 87 });
