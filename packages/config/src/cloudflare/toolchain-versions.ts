/**
 * The Cloudflare toolchain ranges a scaffolded Lunora app declares — the one
 * source for `lunora init`'s overlay. The `templates/*` starters are fetched at
 * runtime and cannot import this, so `tests/vis-templates` asserts that every
 * template declaring one of these packages declares exactly this range.
 *
 * `@cloudflare/workers-types` is on the v5 line: v4 ended at 4.20260702.1, and
 * v5's root entrypoint is the latest runtime (AI Search, Artifacts, Analytics
 * SQL, tracing `setStatus`). `wrangler` >= 4.145.0 accepts the Analytics SQL
 * `analytics` binding that `ctx.analyticsSql` makes `lunora dev` write, and
 * >= 4.142.0 declares and runs Workflows in `exports`, which codegen writes.
 * `@cloudflare/vite-plugin` matches the wrangler it embeds.
 *
 * Bump it together with the `cloudflare` / `vite` catalogs in `pnpm-workspace.yaml`.
 */
const CLOUDFLARE_TOOLCHAIN_VERSIONS: Readonly<Record<"@cloudflare/vite-plugin" | "@cloudflare/workers-types" | "wrangler", string>> = {
    "@cloudflare/vite-plugin": "^1.62.4",
    "@cloudflare/workers-types": "^5.20261002.1",
    wrangler: "^4.146.0",
};

export default CLOUDFLARE_TOOLCHAIN_VERSIONS;
