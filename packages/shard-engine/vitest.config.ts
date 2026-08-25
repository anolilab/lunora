import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * These numbers are a RATCHET, not a target: they sit under the current
 * measurement so a regression still fails, and every engine unit test added
 * should raise them. Do not lower them.
 *
 * Measured on both CI legs, because they do not agree: Node 22 (which CI runs
 * `test:affected:coverage` on) gives 88.9 stmts / 79.2 branches / 88.0 funcs /
 * 88.9 lines, Node 24 gives 89.0 / 79.5 / 88.1 / 89.0. Part of that gap is not
 * instrumentation noise but real branch selection — `node:sqlite` ships FTS5
 * from 22.23 on, so the older leg takes the LIKE-scan path through ctx-db's
 * search code instead. The floors are pinned ~3pp under the LOWER leg: a floor
 * fitted tightly to the local (Node 24) number reds in CI on the identical
 * commit, which is exactly how PR #408 failed.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 75, functions: 85, lines: 86, statements: 86 });
