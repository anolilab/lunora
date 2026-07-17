import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: below the default floor; raise as coverage improves.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 60, functions: 65, lines: 75, statements: 75 });
