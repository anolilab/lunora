import { getVitestConfig } from "../../tools/get-vitest-config";

// ratchet: branches below the default floor; raise as coverage improves.
export default getVitestConfig({ test: { environment: "node" } }, { branches: 60 });
