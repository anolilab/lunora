/** Types `env` from `cloudflare:test` as this worker's bindings. */
import type { Env as TestEnv } from "./test-worker.ts";

declare global {
    namespace Cloudflare {
        interface Env extends TestEnv {}
    }
}
