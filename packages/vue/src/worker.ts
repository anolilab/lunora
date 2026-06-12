/**
 * `@cirrus/vue/worker` — framework-worker composition helpers for Nuxt/Nitro.
 *
 * Exports `withCirrus` (`withFrameworkWorker` from `@cirrus/runtime`), which
 * wraps a framework's fetch handler as Cirrus's fallback `httpRouter`. Cirrus
 * mounts only the reserved `/_cirrus/*` plane (RPC, WS, admin) + `ShardDO`;
 * all other requests fall through to the framework handler.
 *
 * ## Nitro / Nuxt integration
 *
 * Nitro does **not** expose its emitted fetch handler as an importable virtual
 * module — there is no `#nitro-cloudflare-handler` or equivalent specifier in
 * any documented Nitro API. Single-worker composition of `/_cirrus/*` into a
 * Nitro output via `withCirrus` is therefore not achievable through any
 * supported mechanism.
 *
 * The supported integration for Nuxt is a **two-worker split**:
 * - The Nuxt/Nitro SSR worker (`wrangler.jsonc`, `cloudflare_module` preset) handles all pages and server routes.
 * - A separate standalone Cirrus worker (`wrangler.cirrus.jsonc`, `cirrus/server.ts`) owns `/_cirrus/*` + `ShardDO`.
 * - `runtimeConfig.public.cirrusUrl` (NUXT_PUBLIC_CIRRUS_URL) tells the SSR loader and the browser client where to reach the Cirrus worker.
 *
 * `withCirrus` remains useful for other frameworks whose build toolchain
 * genuinely exposes the emitted handler as an importable module.
 */
export type {
    CirrusWorker as ComposedWorker,
    ExecutionContextLike,
    FrameworkWorkerOptionsInput,
    FrameworkHostHandler as NitroCloudflareHandler,
    ScheduledControllerLike,
    FrameworkWorkerOptions as WithCirrusOptions,
} from "@cirrus/runtime";
export { withFrameworkWorker as withCirrus } from "@cirrus/runtime";
