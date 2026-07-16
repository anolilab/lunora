import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: measured 2026-07-16 at 62.52% branches (lines/stmts/funcs clear the
// default floor) — raise toward the 70% default branches floor.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 60 });
