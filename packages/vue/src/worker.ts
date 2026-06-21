/**
 * `@lunora/vue/worker` — framework-worker composition helpers for Nuxt/Nitro.
 *
 * Exports `withLunora` (`withFrameworkWorker` from `@lunora/runtime`), which
 * wraps a framework's fetch handler as Lunora's fallback `httpRouter`. Lunora
 * mounts only the reserved `/_lunora/*` plane (RPC, WS, admin) + `ShardDO`;
 * all other requests fall through to the framework handler.
 *
 * ## Nitro / Nuxt integration
 *
 * Nitro does **not** expose its emitted fetch handler as an importable virtual
 * module — there is no `#nitro-cloudflare-handler` or equivalent specifier in
 * any documented Nitro API. Single-worker composition of `/_lunora/*` into a
 * Nitro output via `withLunora` is therefore not achievable through any
 * supported mechanism.
 *
 * The supported integration for Nuxt is a **two-worker split**:
 * - The Nuxt/Nitro SSR worker (`wrangler.jsonc`, `cloudflare_module` preset) handles all pages and server routes.
 * - A separate standalone Lunora worker (`wrangler.lunora.jsonc`, `lunora/server.ts`) owns `/_lunora/*` + `ShardDO`.
 * - `runtimeConfig.public.lunoraUrl` (NUXT_PUBLIC_LUNORA_URL) tells the SSR loader and the browser client where to reach the Lunora worker.
 *
 * `withLunora` remains useful for other frameworks whose build toolchain
 * genuinely exposes the emitted handler as an importable module.
 */
export type {
    LunoraWorker as ComposedWorker,
    ExecutionContextLike,
    FrameworkWorkerOptionsInput,
    FrameworkHostHandler as NitroCloudflareHandler,
    ScheduledControllerLike,
    FrameworkWorkerOptions as WithLunoraOptions,
} from "@lunora/runtime";
export { withFrameworkWorker as withLunora } from "@lunora/runtime";
