import type { Config } from "@react-router/dev/config";

/**
 * React Router v7 framework-mode config.
 *
 * `ssr: true` keeps server-side rendering on — the Lunora worker (composed via
 * `virtual:lunora/worker`) routes non-`/_lunora/*` requests to React Router's SSR
 * handler, so the app renders on the Cloudflare Worker and hydrates on the client.
 *
 * No Cloudflare preset is needed here: the worker entry is owned by Lunora's
 * `frameworkComposePlugin` (see `wrangler.jsonc` `main: "virtual:lunora/worker"`)
 * and the `@cloudflare/vite-plugin` in `vite.config.ts` runs the build, so React
 * Router only needs to emit `virtual:react-router/server-build`.
 */
export default {
    ssr: true,
} satisfies Config;
