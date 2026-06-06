/**
 * Ambient stub for the `cloudflare:workers` module so registry items that read
 * Cloudflare bindings (e.g. `storage`, `backup`) type-check standalone under
 * `registry/tsconfig.json` (which ships only `types: ["node"]`). In a real
 * Cirrus project, `@cloudflare/workers-types`' `cloudflare:workers` module — and
 * the project's generated `Env` — provide the precise binding types and
 * supersede this shim.
 */
declare module "cloudflare:workers" {
    /**
     * The Worker's configured bindings (R2 buckets, vars, secrets, …), typed as
     * `unknown`-valued so items must narrow each binding explicitly (a guarded
     * string for vars/secrets, an `as R2BucketLike` for buckets) rather than
     * leaning on `any`. The consumer's generated `Env` supplies precise types.
     */
    export const env: Record<string, unknown>;
}
