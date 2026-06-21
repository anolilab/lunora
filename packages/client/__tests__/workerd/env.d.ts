/**
 * Augments `Cloudflare.Env` so `env` from `cloudflare:test` is typed as the
 * integration test worker's bindings (see `./test-worker.ts`).
 */
import type { Env as TestEnv } from "./test-worker.ts";

declare global {
    namespace Cloudflare {
        interface Env extends TestEnv {}
    }
}
