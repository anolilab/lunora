/**
 * Augments `Cloudflare.Env` so `env` from `cloudflare:test` is typed as
 * the test worker's bindings (see `./test-worker.ts`).
 *
 * `@cloudflare/vitest-pool-workers@0.16.x` exports `env: Cloudflare.Env`,
 * so this is the canonical augmentation point.
 */
import type { Env as TestEnv } from "./test-worker.ts";

declare global {
    namespace Cloudflare {
        interface Env extends TestEnv {}
    }
}
