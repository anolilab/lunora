/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * Augments `Cloudflare.Env` so `env` from `cloudflare:test` is typed as the test
 * worker's bindings (see `./test-worker`).
 */
import type { PrivacyTestDO } from "./test-worker";

declare global {
    namespace Cloudflare {
        interface Env {
            PRIVACY: DurableObjectNamespace<PrivacyTestDO>;
        }
    }
}
