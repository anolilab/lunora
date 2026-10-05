import { fileURLToPath } from "node:url";

import codspeedPlugin from "@codspeed/vitest-plugin";

import { getBenchConfig } from "../../tools/get-bench-config";

/**
 * Benches run in plain node (`tools/get-bench-config.ts`). `BoxSessionDO`
 * extends the workerd-only `cloudflare:workers` `DurableObject`, so the session
 * benches load the same minimal stub the node test project does.
 */
export default getBenchConfig(
    {
        resolve: {
            alias: {
                "cloudflare:workers": fileURLToPath(new URL("__tests__/__stubs__/cloudflare-workers.ts", import.meta.url)),
            },
        },
    },
    // This app's vitest is not the repo root's copy (vite 8 peers), so it loads the
    // CodSpeed plugin it resolves itself — see `getBenchConfig`.
    codspeedPlugin,
);
