import type { ArgsOf, FunctionReference, ReturnOf } from "lunorash/client";
import { LunoraClient } from "lunorash/client";
import { DestroyRef, inject, Injectable, signal, type Signal } from "@angular/core";

/**
 * Minimal Angular wiring for Lunora — there is no `@lunora/angular` adapter, so
 * this service is the bridge between the framework-neutral vanilla
 * `LunoraClient` and Angular's reactivity. It owns one browser `LunoraClient`
 * (opens its WebSocket lazily on the first subscription) and exposes:
 *
 *   - `liveQuery(ref, args, opts)` — subscribe a Lunora query and surface every
 *     server delta through an Angular `signal`. The subscription is torn down
 *     automatically when the calling injection context is destroyed.
 *   - `mutate(ref, args, opts)` — run a Lunora mutation.
 *
 * Swap this for a real `@lunora/angular` adapter once one ships; the component
 * API (a `signal` + a `mutate` call) is deliberately small so the migration is
 * mechanical.
 */
@Injectable({ providedIn: "root" })
export class LunoraService {
    /**
     * Same origin as the page (the single-worker deploy: `/_lunora/ws` loops
     * back into this app's own Nitro/Cloudflare worker). Point at a remote URL
     * for split deploys.
     */
    private readonly client = new LunoraClient({ url: globalThis.location?.origin ?? "" });

    /**
     * Subscribe to a Lunora query and mirror its value into a `signal`. Returns
     * the read-only signal; the underlying WebSocket subscription is closed when
     * the caller's `DestroyRef` fires (i.e. the component is destroyed).
     */
    public liveQuery<F extends FunctionReference>(reference: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Signal<ReturnOf<F> | undefined> {
        const value = signal<ReturnOf<F> | undefined>(undefined);

        const unsubscribe = this.client.subscribe(
            reference,
            args,
            (next) => {
                value.set(next);
            },
            options,
        );

        inject(DestroyRef).onDestroy(unsubscribe);

        return value.asReadonly();
    }

    /** Run a Lunora mutation (e.g. `api.messages.send`). */
    public async mutate<F extends FunctionReference>(reference: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        return this.client.mutation(reference, args, options);
    }
}
