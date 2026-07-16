import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: measured 2026-07-16 at 57.31% branches (94% lines, 100% funcs) —
// raise toward the 70% default branches floor.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 55 });
