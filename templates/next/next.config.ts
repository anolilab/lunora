import type { NextConfig } from "next";

// Two-worker split: Next.js builds through the standard OpenNext Cloudflare
// adapter (`opennextjs-cloudflare build`) with no custom entrypoint. Lunora
// realtime (`/_lunora/*` + ShardDO) runs in a SEPARATE Cloudflare Worker — see
// the root `wrangler.jsonc` + `lunora/server.ts` (the Next SSR worker's own
// config is `wrangler.opennext.jsonc`).
//
// Why two workers? OpenNext owns the worker entry it emits (`.open-next/worker.js`)
// and does not expose a supported hook to compose extra routes or Durable Object
// classes into that output. The two-worker split is the documented path.
//
// NEXT_PUBLIC_LUNORA_URL points both the RSC loader and the browser client at
// the Lunora worker. It is inlined into the client bundle at build time.
const nextConfig: NextConfig = {};

export default nextConfig;
