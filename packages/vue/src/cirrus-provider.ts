import type { CirrusClient } from "@cirrus/client";
import type { App, InjectionKey } from "vue";
import { inject, provide } from "vue";

/**
 * Injection key carrying the {@link CirrusClient} down the component tree.
 * Exported so advanced consumers can inject it by hand; most apps use
 * {@link createCirrus} or {@link provideCirrus}.
 */
export const CIRRUS_INJECTION_KEY: InjectionKey<CirrusClient> = Symbol("cirrus.client");

/**
 * Vue plugin form: `app.use(createCirrus(client))`. Mirrors the React
 * `CirrusProvider` — establishes the single app-wide client every composable
 * resolves through {@link useCirrusClient}.
 *
 * The client is framework-neutral (`@cirrus/client`): it owns the WebSocket
 * transport, subscription registry, offline queue, and delta-merge. This plugin
 * only wires it into Vue's `provide`/`inject` graph; it adds no React, no store,
 * and no extra reactivity layer.
 */
export const createCirrus = (client: CirrusClient): { install: (app: App) => void } => {
    return {
        install(app: App): void {
            app.provide(CIRRUS_INJECTION_KEY, client);
        },
    };
};

/**
 * Composition-API form: call inside a parent component's `setup()` to provide
 * the client to its subtree. The counterpart to `app.use(createCirrus(client))`
 * when you'd rather scope the client to a subtree than the whole app. Must run
 * synchronously inside `setup()` (Vue's `provide` constraint).
 */
export const provideCirrus = (client: CirrusClient): void => {
    provide(CIRRUS_INJECTION_KEY, client);
};

/**
 * Read the {@link CirrusClient} from the nearest provider. Throws with a clear
 * message when called outside a `createCirrus`/`provideCirrus` scope so the
 * failure points at the missing provider rather than a later `undefined` deref.
 */
export const useCirrusClient = (): CirrusClient => {
    const client = inject(CIRRUS_INJECTION_KEY, undefined);

    if (!client) {
        throw new Error("useCirrusClient(): no CirrusClient provided — call app.use(createCirrus(client)) or provideCirrus(client) in a parent setup().");
    }

    return client;
};
