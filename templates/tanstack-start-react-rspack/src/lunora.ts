import { lunora } from "./app";

/**
 * The Lunora-only Worker `rsbuild dev` runs (`wrangler.jsonc` `main`) — the RPC
 * and live-query plane behind the dev server's `/_lunora/*` proxy, while SSR
 * renders in the dev server itself. Not `src/server.ts`: TanStack Start reads
 * that path as its own server entry.
 */
const app = lunora.build();

export const ShardDO = app.ShardDO;
export default app;
