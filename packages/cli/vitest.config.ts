import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: measured 2026-07-16 at 77.67% lines / 77.58% stmts / 67.77% funcs /
// 64.8% branches — raise toward the 80/80/80/70 default floor.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 60, functions: 65, lines: 75, statements: 75 });
