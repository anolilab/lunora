import { getVitestConfig } from "../../tools/get-vitest-config";

// Pure-Node suite: the SQL store core is dialect-parameterized logic over an
// injected SqlExec, so the unit tests feed plain-object exec/dialect doubles
// (and a node:sqlite-backed exec) and never need workerd.
//
// ratchet: measured 2026-07-16 at 68.13% lines / 68.65% stmts / 72.37% funcs /
// 51% branches — raise toward the 80/80/80/70 default floor.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 48, functions: 70, lines: 65, statements: 65 });
