/// <reference types="@cloudflare/workers-types" />
// Cloudflare's ambient globals live here, not in the package tsconfig: `src/`
// is platform-neutral, and a package-wide reference would let a workerd type
// slip into shipped code and still compile.

/** The test Worker's bindings: one fetch service and one RPC entrypoint (see `wrangler.jsonc`). */
interface Env {
    SERVICE_GATEWAY: Service;
    SERVICE_PARSER: Fetcher;
}

export type { Env };

export default {
    fetch: (): Response => new Response("lunora-server-test-worker"),
};
