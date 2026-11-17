import type { AssetHeadersLogger } from "@lunora/config/cloudflare";

/**
 * Write the Lunora-managed `_headers` block into Nitro's public output once a
 * production build is compiled, so a static asset Cloudflare serves without
 * running the Worker still carries the security headers. On `compiled`, after
 * Nitro's own `cloudflare_module` preset has written its route-rule headers there,
 * so both are kept. Written only when that directory is wrangler's
 * `assets.directory`.
 *
 * No immutable caching rule: Nuxt's `_nuxt/builds/` holds unhashed app-manifest
 * files (`latest.json`), and Nitro writes its own cache rules for that tree.
 * `@lunora/config` is imported here, at build time, so the module stays cheap to load.
 */
const writeNuxtAssetHeaders = async (build: { dev: boolean; publicDirectory: string }, rootDirectory: string, logger: AssetHeadersLogger): Promise<void> => {
    if (build.dev) {
        return;
    }

    const { emitProjectAssetHeaders } = await import("@lunora/config/cloudflare");

    emitProjectAssetHeaders({ outputDirectory: build.publicDirectory, projectRoot: rootDirectory, requireAssetsDirectory: true }, logger);
};

export default writeNuxtAssetHeaders;
