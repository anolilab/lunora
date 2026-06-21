/**
 * Test entry-point Worker for `@lunora/storage` integration tests.
 *
 * Provides an R2 binding (`BUCKET`) backed by Miniflare's in-process R2
 * emulator. Tests drive `createStorage(env.BUCKET)` directly via
 * `cloudflare:test`'s `env` export — the default fetch handler exists only to
 * satisfy the pool runner.
 */

export interface Env {
    BUCKET: R2Bucket;
}

export default {
    async fetch(_request: Request, _env: Env): Promise<Response> {
        return new Response("test-worker", { status: 200 });
    },
};
