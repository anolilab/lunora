import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig({ test: { environment: "node" } }, { branches: 80, functions: 88, lines: 88, statements: 88 });
