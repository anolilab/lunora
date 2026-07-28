import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Lower floors than the repo default, deliberately.
 *
 * These adapters are Durable-Object plumbing: most of their branches only run
 * with a real `DurableObjectState`, which is why they are exercised end-to-end
 * by `@lunora/do`'s workerd project rather than here. Raising these floors with
 * doubles would assert the doubles, not the adapters.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 40, functions: 40, lines: 40, statements: 40 });
