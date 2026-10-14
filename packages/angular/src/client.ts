/* eslint-disable no-secrets/no-secrets -- camelCase identifiers in prose, not secrets */
import type { EnvironmentProviders } from "@angular/core";
import { inject, InjectionToken, makeEnvironmentProviders } from "@angular/core";
import type { LunoraClientOptions } from "@lunora/client";
import { LunoraClient } from "@lunora/client";

/**
 * Same-origin default: the page's origin in the browser, `""` during SSR / Node
 * where there is no `location`. Matches the single-worker deploy where
 * `/_lunora/ws` loops back into the app's own worker. `globalThis` is cast to make
 * `location` genuinely optional — the DOM lib types it as always present, but it
 * is absent on the server.
 *
 * The `""` server fallback is safe for the common flow: the reactive primitives
 * (`liveQuery`, `subscription`, `stream`, `paginatedQuery`, `presence`,
 * `hydratePreloaded`, `flag`, `flags`)
 * gate their `client.subscribe(...)` / `client.stream(...)` on the Angular
 * browser platform, so an SSR
 * render opens no socket even though Node 22+ exposes a global `WebSocket` (see
 * `shouldOpenSubscription` in `./platform`). But **server-side data-loading** (a
 * `query`/`mutation` run during SSR) with `""` builds a relative URL that native
 * `fetch` rejects (`TypeError: Failed to parse URL`); for that, pass an explicit
 * `url` to {@link provideLunora}.
 */
const sameOriginUrl = (): string => (globalThis as { location?: Location }).location?.origin ?? "";

/**
 * DI token carrying the framework-neutral {@link LunoraClient}. Every reactive
 * primitive in this adapter (`liveQuery`, `mutate`, `connectionStatus`) reads the
 * client from here, so a single {@link provideLunora} in the application config
 * wires the whole app.
 *
 * The token has a root-scoped default factory, so it resolves even without
 * {@link provideLunora}: it builds one same-origin browser client (which opens
 * its WebSocket lazily on the first subscription). Call {@link provideLunora} to
 * point it at a remote URL or hand it a pre-built client.
 * @experimental
 */
export const LUNORA_CLIENT: InjectionToken<LunoraClient> = new InjectionToken<LunoraClient>("lunora.client", {
    factory: (): LunoraClient => new LunoraClient({ url: sameOriginUrl() }),
    providedIn: "root",
});

/**
 * Options accepted by {@link provideLunora}. Identical to {@link LunoraClientOptions}
 * except `url` is optional — it defaults to the page origin in the browser (and to
 * `""` on the server; pass an explicit `url` for SSR data-loading — see
 * {@link sameOriginUrl}).
 * @experimental
 */
export type ProvideLunoraOptions = Omit<LunoraClientOptions, "url"> & { url?: string };

/**
 * Wire a {@link LunoraClient} into the application injector. Add the result to the
 * `providers` array of an Angular application config (or any `EnvironmentProviders`
 * consumer):
 *
 * ```ts
 * export const appConfig: ApplicationConfig = {
 *     providers: [provideLunora({ url: "https://api.example.com" })],
 * };
 * ```
 *
 * Pass {@link LunoraClientOptions} to configure a fresh client (URL defaults to
 * the page origin), or hand in an already-constructed {@link LunoraClient} to
 * share one instance (e.g. a client you also preload against during SSR).
 * @experimental
 */
export const provideLunora = (optionsOrClient: LunoraClient | ProvideLunoraOptions = {}): EnvironmentProviders =>
    makeEnvironmentProviders([
        {
            provide: LUNORA_CLIENT,
            useFactory: (): LunoraClient => {
                if (optionsOrClient instanceof LunoraClient) {
                    return optionsOrClient;
                }

                return new LunoraClient({ ...optionsOrClient, url: optionsOrClient.url ?? sameOriginUrl() });
            },
        },
    ]);

/**
 * Read the {@link LunoraClient} from the current injector. Call inside an
 * injection context (a component/service field initializer or constructor, or a
 * `runInInjectionContext` callback). Use it to hold the client for imperative
 * calls — e.g. `mutation`/`action` from event handlers, which run outside an
 * injection context:
 *
 * ```ts
 * private readonly client = injectLunoraClient();
 * send = (text: string) => this.client.mutation(api.messages.send, { text });
 * ```
 * @experimental
 */
export const injectLunoraClient = (): LunoraClient => inject(LUNORA_CLIENT);

/**
 * Resolve the {@link LunoraClient} a reactive primitive should use: the explicit
 * `client` when given, else the injected {@link LUNORA_CLIENT}. The single lookup
 * path shared by `liveQuery`, `mutate`, and `connectionStatus` — passing `client`
 * lets them run outside an injection context (or in a test), while omitting it
 * resolves from DI. Must be called within an injection context when `client` is
 * omitted (it delegates to {@link injectLunoraClient}).
 */
export const resolveLunoraClient = (client?: LunoraClient): LunoraClient => client ?? injectLunoraClient();
