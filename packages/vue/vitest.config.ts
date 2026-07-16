import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: measured 2026-07-16 at 77.53% lines / 76.78% stmts / 79.23% funcs /
// 56.76% branches — raise toward the 80/80/80/70 default floor.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 55, functions: 75, lines: 75, statements: 75 });
