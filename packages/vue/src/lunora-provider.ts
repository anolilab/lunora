import type { LunoraClient } from "@lunora/client";
import type { App, InjectionKey } from "vue";
import { inject, provide } from "vue";

/**
 * Injection key carrying the {@link LunoraClient} down the component tree.
 * Exported so advanced consumers can inject it by hand; most apps use
 * {@link createLunora} or {@link provideLunora}.
 */
export const LUNORA_INJECTION_KEY: InjectionKey<LunoraClient> = Symbol("lunora.client");

/**
 * Vue plugin form: `app.use(createLunora(client))`. Mirrors the React
 * `LunoraProvider` — establishes the single app-wide client every composable
 * resolves through {@link useLunora}.
 *
 * The client is framework-neutral (`@lunora/client`): it owns the WebSocket
 * transport, subscription registry, offline queue, and delta-merge. This plugin
 * only wires it into Vue's `provide`/`inject` graph (read it with
 * {@link useLunora}); it adds no React, no store, and no extra reactivity layer.
 */
export const createLunora = (client: LunoraClient): { install: (app: App) => void } => {
    return {
        install(app: App): void {
            app.provide(LUNORA_INJECTION_KEY, client);
        },
    };
};

/**
 * Composition-API form: call inside a parent component's `setup()` to provide
 * the client to its subtree. The counterpart to `app.use(createLunora(client))`
 * when you'd rather scope the client to a subtree than the whole app. Must run
 * synchronously inside `setup()` (Vue's `provide` constraint).
 */
export const provideLunora = (client: LunoraClient): void => {
    provide(LUNORA_INJECTION_KEY, client);
};

/**
 * Read the {@link LunoraClient} from the nearest provider — the Vue counterpart
 * to `@lunora/react`/`@lunora/solid`'s `useLunora`. Throws with a clear message
 * when called outside a `createLunora`/`provideLunora` scope so the failure
 * points at the missing provider rather than a later `undefined` deref.
 */
export const useLunora = (): LunoraClient => {
    const client = inject(LUNORA_INJECTION_KEY, undefined);

    if (!client) {
        throw new Error("useLunora(): no LunoraClient provided — call app.use(createLunora(client)) or provideLunora(client) in a parent setup().");
    }

    return client;
};
