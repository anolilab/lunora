/**
 * Cloudflare worker entrypoint extra-exports for Analog's Nitro `cloudflare-module`
 * build. Nitro's `cloudflare-module` preset appends the named exports from a
 * project-root `exports.cloudflare.ts` to the emitted worker entry
 * (`dist/analog/server/index.mjs`), so the `ShardDO` Durable Object class ships
 * in the SAME single worker as the Analog SSR handler.
 *
 * `ShardDO` is the concrete Durable Object class produced by
 * `defineApp().build()` (see `lunora/server.ts`, `export const ShardDO =
 * app.ShardDO`). The generated `lunora/_generated/shard.ts` exports a
 * `createShardDO(config)` FACTORY, not a bound class — so re-export the built
 * class from `lunora/server`, the same source the `/_lunora/**` server route
 * delegates to. One DO class, one binding (`SHARD`), one deploy.
 *
 * NOTE: verify the exact `exports.cloudflare.ts` filename/hook against your
 * pinned Nitro/Analog versions — see this template's README for the supported
 * alternatives if the file is not picked up.
 */
export { ShardDO } from "./lunora/server";
