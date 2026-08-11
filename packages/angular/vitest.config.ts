import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: all four below the default floor (voice-audio.ts is largely untested);
// raise as coverage improves.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 64, functions: 79, lines: 79, statements: 79 });
