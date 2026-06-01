/**
 * Augments `Cloudflare.Env` so `env` from `cloudflare:test` is typed as the
 * integration test worker's bindings (see `./test-worker.ts`).
 */
import type { Env as TestEnv } from "./test-worker.ts";

declare global {
    namespace Cloudflare {
        // Interface (not a type alias) is required for declaration merging into
        // the `Cloudflare.Env` namespace; the empty body intentionally inherits
        // every binding from TestEnv.
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        interface Env extends TestEnv {}
    }
}
