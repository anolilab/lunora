/**
 * Augments `Cloudflare.Env` so `env` from `cloudflare:test` is typed as
 * the test worker's bindings (see `./test-worker.ts`).
 */
import type { TestEnv } from "./test-worker";

declare global {
    namespace Cloudflare {
        interface Env extends TestEnv {}
    }
}
