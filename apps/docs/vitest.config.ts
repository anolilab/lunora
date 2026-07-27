import { fileURLToPath } from "node:url";

import { getVitestConfig } from "../../tools/get-vitest-config";

/** Mirrors the `@/*` path alias the app's tsconfig defines. */
export default getVitestConfig({
    resolve: { alias: { "@": fileURLToPath(new URL("src", import.meta.url)) } },
    test: { environment: "node" },
});
