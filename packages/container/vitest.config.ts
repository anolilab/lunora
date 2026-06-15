import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            // `@cloudflare/containers` imports the workerd-only `cloudflare:workers`
            // module at module scope; alias it to a minimal stub so the
            // `LunoraContainer` base class is testable in plain Node.
            "cloudflare:workers": fileURLToPath(new URL("__tests__/__stubs__/cloudflare-workers.ts", import.meta.url)),
        },
    },
    test: { environment: "node" },
});
