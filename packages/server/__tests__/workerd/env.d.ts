/**
 * Types `env` from `cloudflare:test` as the test Worker's bindings (see
 * `./test-worker.ts`); `@cloudflare/vitest-plugin` exports `env: Cloudflare.Env`.
 */
import type { Env as TestEnv } from "./test-worker";

declare global {
    namespace Cloudflare {
        interface Env extends TestEnv {}
    }
}
