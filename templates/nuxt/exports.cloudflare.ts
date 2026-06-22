/**
 * Cloudflare worker entrypoint extra-exports for Nuxt's Nitro `cloudflare_module`
 * build. The preset appends the named exports from a project-root
 * `exports.cloudflare.ts` onto the emitted worker entry (`.output/server/index.mjs`),
 * so the `ShardDO` Durable Object class ships in the SAME single worker as the
 * Nuxt SSR handler and the `/_lunora/**` route (mounted by `@lunora/nuxt`).
 *
 * `ShardDO` is the concrete Durable Object class produced by `defineApp().build()`
 * (see `lunora/server.ts`, `export const ShardDO = app.ShardDO`). The generated
 * `lunora/_generated/shard.ts` exports a `createShardDO(config)` FACTORY, not a
 * bound class — so re-export the built class from `lunora/server`, the same source
 * `@lunora/nuxt` mounts as the `/_lunora/**` worker. One DO class, one `SHARD`
 * binding, one deploy.
 *
 * NOTE: verify the exact `exports.cloudflare.ts` filename/hook against your pinned
 * Nitro/Nuxt versions — see this template's README for supported alternatives if
 * the file is not picked up.
 */
export { ShardDO } from "./lunora/server";
