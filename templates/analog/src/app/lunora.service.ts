import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/angular";
import { injectLunoraClient, liveQuery, mutate } from "@lunora/angular";
import { Injectable, type Signal } from "@angular/core";

/**
 * Thin Angular wiring for Lunora on top of the first-class `@lunora/angular`
 * adapter. It holds one browser `LunoraClient` (resolved from `LUNORA_CLIENT`,
 * which `provideLunora()` in `app.config.ts` wires; the client opens its WebSocket
 * lazily on the first subscription) and re-exposes the adapter's two primitives
 * behind a service, keeping the deliberately small component API stable:
 *
 *   - `liveQuery(ref, args, opts)` — subscribe a Lunora query and surface every
 *     server delta through an Angular `signal`. The subscription is torn down
 *     automatically when the calling injection context is destroyed.
 *   - `mutate(ref, args, opts)` — run a Lunora mutation.
 *
 * Prefer importing `liveQuery` / `mutate` from `@lunora/angular` directly in new
 * components; this service is a convenience wrapper that captures the client for
 * mutations fired from event handlers (which run outside an injection context).
 */
@Injectable({ providedIn: "root" })
export class LunoraService {
    /** The shared browser client from `LUNORA_CLIENT` (see `provideLunora()` in `app.config.ts`). */
    private readonly client = injectLunoraClient();

    /**
     * Subscribe to a Lunora query and mirror its value into a `signal`. Returns
     * the read-only signal; the underlying WebSocket subscription is closed when
     * the caller's `DestroyRef` fires (i.e. the component is destroyed). Call from
     * an injection context (a component field initializer or constructor).
     */
    public liveQuery<F extends FunctionReference>(reference: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Signal<ReturnOf<F> | undefined> {
        return liveQuery(reference, args, { ...options, client: this.client });
    }

    /** Run a Lunora mutation (e.g. `api.messages.send`). */
    public async mutate<F extends FunctionReference>(reference: F, args: ArgsOf<F>, options: { shardKey?: string } = {}): Promise<ReturnOf<F>> {
        return mutate(reference, args, { ...options, client: this.client });
    }
}
