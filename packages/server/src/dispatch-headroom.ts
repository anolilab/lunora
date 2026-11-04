import type { TransactionHeadroom } from "@lunora/shard-engine";
import { TransactionHeadroomTracker } from "@lunora/shard-engine";

/** Where the current dispatch's tracker lives: an `AsyncLocalStorage` fits, and so does any stand-in. */
interface HeadroomScope {
    getStore: () => TransactionHeadroomTracker | undefined;
    run: <R>(store: TransactionHeadroomTracker, body: () => R) => R;
}

/**
 * A resource meter with a stable identity whose budget is per dispatch.
 *
 * Production builds a fresh `createShardCtxDb` writer — and with it a fresh
 * {@link TransactionHeadroomTracker} — for every dispatch. The in-process
 * runtime builds one writer per identity view, so it hands that writer this
 * forwarder and runs each top-level entry under its own tracker: the ceilings
 * are the engine defaults rather than "unmetered".
 *
 * Without a `scope` the budget is swapped at each entry, which is only right
 * while entries do not overlap. Queries and actions do overlap, so a host that
 * runs them concurrently supplies a scope (the testing harness passes an
 * `AsyncLocalStorage`) and every await continuation keeps reading its own
 * dispatch's tracker. The scope is injected because `@lunora/server` also loads
 * in runtimes without `node:async_hooks`.
 */
class DispatchHeadroom extends TransactionHeadroomTracker {
    private fallback = new TransactionHeadroomTracker();

    private readonly scope: HeadroomScope | undefined;

    public constructor(scope?: HeadroomScope) {
        super();
        this.scope = scope;
    }

    /** Run `body` as one dispatch with a full budget. */
    public run<R>(body: () => R): R {
        if (this.scope === undefined) {
            this.fallback = new TransactionHeadroomTracker();

            return body();
        }

        return this.scope.run(new TransactionHeadroomTracker(), body);
    }

    public override headroom(): TransactionHeadroom {
        return this.current().headroom();
    }

    public override recordRead(count: number): void {
        this.current().recordRead(count);
    }

    public override recordReadBytes(bytes: number): void {
        this.current().recordReadBytes(bytes);
    }

    public override recordDocumentRead(key: string, bytes: number): void {
        this.current().recordDocumentRead(key, bytes);
    }

    public override recordWrite(row: unknown): void {
        this.current().recordWrite(row);
    }

    private current(): TransactionHeadroomTracker {
        return this.scope?.getStore() ?? this.fallback;
    }
}

export type { HeadroomScope };
export { DispatchHeadroom };
