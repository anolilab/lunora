/**
 * Ambient stub for the `cloudflare:workers` module so registry items that read
 * Cloudflare bindings (e.g. `storage`, `backup`) type-check standalone under
 * `registry/tsconfig.json` (which ships only `types: ["node"]`).
 *
 * It mirrors `@cloudflare/workers-types` EXACTLY, and that is the point. The
 * stub used to type `env` as `Record<string, unknown>`, which indexes freely —
 * so five items indexed it, this gate went green, and every one of them failed
 * `tsc --noEmit` in a real consumer with `TS7053` / `TS2339`. The real module
 * types `env` as `Cloudflare.Env`, an interface declaration-merged from the
 * project's own `worker-configuration.d.ts` and therefore **empty** until the
 * project runs `wrangler types` — a fresh `lunora init` scaffold has not.
 *
 * So items must narrow `env` through the generated `CloudflareBindings`
 * (`./lunora-generated-server.d.ts`) rather than index it directly, and the
 * empty interface here is what holds them to it.
 */
declare namespace Cloudflare {
    // Empty, as `@cloudflare/workers-types` declares it. A project extends it by
    // redeclaring `Cloudflare.Env` (what `wrangler types` generates); TypeScript
    // merges the declarations.
    interface Env {}
}

declare module "cloudflare:workers" {
    /**
     * The Worker's configured bindings (R2 buckets, vars, secrets, …). Empty
     * until the consumer runs `wrangler types` — narrow it through
     * `CloudflareBindings` from `#lunora/_generated/server.js` and then narrow
     * each binding at its use site.
     */
    export const env: Cloudflare.Env;
}
