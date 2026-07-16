import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: measured 2026-07-16 at 79.67% lines / 79.5% stmts / 58.28% branches
// — raise toward the 80/80/80/70 default floor.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 55, lines: 75, statements: 75 });
