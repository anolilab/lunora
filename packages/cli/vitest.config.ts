import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getVitestConfig } from "../../tools/get-vitest-config";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__tests__", "fixtures", "registry-runtime");

// The shipped `registry/` items are copy-in source for a USER's project, so they
// import three specifiers that do not resolve inside this package: the module
// codegen emits there (`#lunora/_generated/server.js`), the Workers runtime
// (`cloudflare:workers`), and packages this one does not depend on. Aliasing them
// to runtime stubs is what lets `registry-backup-item.test.ts` actually execute an
// item instead of asserting on its source text. Nothing under `src/` imports any
// of these, so the aliases are inert for every other suite.
const registryItemAliases = {
    "#lunora/_generated/server.js": join(fixtures, "generated-server.ts"),
    "@lunora/storage": join(fixtures, "lunora-storage.ts"),
    "cloudflare:workers": join(fixtures, "cloudflare-workers.ts"),
};

// ratchet: below the default floor; raise as coverage improves.
export default getVitestConfig(
    { resolve: { alias: registryItemAliases }, test: { environment: "node" } },
    { branches: 60, functions: 65, lines: 75, statements: 75 },
);
