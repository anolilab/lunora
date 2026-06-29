/**
 * `@lunora/flags/web` — optional browser OpenFeature provider (Cloudflare
 * Flagship prefetch). The recommended client path is Lunora's reactive layer
 * (`useFlag` over the WebSocket); this subpath is an escape hatch for apps that
 * want to evaluate flags directly in the browser via the OpenFeature web SDK.
 *
 * Requires `@openfeature/web-sdk` (and `@cloudflare/flagship`) as peers.
 *
 * ```ts
 * import { OpenFeature } from "@openfeature/web-sdk";
 * import { FlagshipClientProvider } from "@lunora/flags/web";
 *
 * await OpenFeature.setProviderAndWait(
 *     new FlagshipClientProvider({ appId: "app-abc", accountId: "acct", prefetchFlags: ["dark-mode"] }),
 * );
 * ```
 * @packageDocumentation
 */
export type { FlagshipClientProviderOptions } from "@cloudflare/flagship/web";
export { FlagshipClientProvider } from "@cloudflare/flagship/web";
