/**
 * The reusable list/resource engine — the counterpart to the form engine for
 * flows that load a collection and mutate it (active sessions now; organization
 * members, invitations, and teams later). It owns load/refetch, a `busy` flag
 * for in-flight mutations, and error mapping, over the shared {@link createStore}.
 */
import type { ControllerContext } from "./config";
import { mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { FlowStatus } from "./types";

/**
 * `TExtra` is a slice of flow-specific state that must live in *this* store
 * rather than beside it — a search term, a total, a cursor.
 *
 * It exists because the alternative does not work: composing two stores means
 * `getState` builds a fresh object on every call, which silently breaks React's
 * `useSyncExternalStore` reference check. Keeping the extra fields here means
 * one snapshot, one stable reference, and no flow having to re-implement the
 * engine to carry two more properties.
 */
interface BaseResourceState<T> {
    /** A mutation (revoke, remove, …) is in flight. */
    busy: boolean;
    error?: string;
    items: ReadonlyArray<T>;
    /** The initial (or refetch) load is in flight. */
    loading: boolean;
    status: FlowStatus;
}

type ResourceState<T, TExtra extends object = Record<never, never>> = BaseResourceState<T> & TExtra;

interface ResourceHandle<T, TExtra extends object = Record<never, never>> {
    destroy: () => void;
    getState: () => ResourceState<T, TExtra>;
    /** Run a mutation, then refetch the list. Errors surface on `state.error`. */
    mutate: (run: () => Promise<unknown>) => Promise<void>;
    /** Update the flow-specific slice. Does not refetch — call `refetch` if it changes the query. */
    patch: (extra: Partial<TExtra>) => void;
    refetch: () => Promise<void>;
    subscribe: (onChange: () => void) => () => void;
}

interface ResourceOptions<TExtra extends object = Record<never, never>> {
    /** Load immediately on creation (default true). */
    autoLoad?: boolean;
    /** Starting value for the flow-specific slice. */
    initialExtra?: TExtra;
}

const createResourceController = <T, TExtra extends object = Record<never, never>>(
    context: ControllerContext,
    load: (context: ControllerContext, extra: TExtra) => Promise<{ extra?: Partial<TExtra>; items: ReadonlyArray<T> } | ReadonlyArray<T>>,
    options: ResourceOptions<TExtra> = {},
): ResourceHandle<T, TExtra> => {
    const store = createStore<ResourceState<T, TExtra>>({
        busy: false,
        items: [],
        loading: true,
        status: "idle",
        ...(options.initialExtra ?? ({} as TExtra)),
    });

    /** Read the flow-specific slice back out of the merged state. */
    const extra = (): TExtra => store.get();

    /*
     * The engine's own fields, typed. `Partial<A & B>` is not assignable to
     * `Partial<A> & Partial<B>` in TypeScript, so a plain `store.update({ busy })`
     * fails to check against the intersection — this is the one place that is
     * reconciled, rather than a cast at each of the eight call sites.
     */
    const patchBase = (next: Partial<BaseResourceState<T>>): void => {
        store.update(next as Partial<ResourceState<T, TExtra>>);
    };

    const refetch = async (): Promise<void> => {
        patchBase({ error: undefined, loading: true, status: "submitting" });

        try {
            const result = await load(context, extra());
            // A loader that needs no extra state just returns the array.
            const { extra: patched, items } = Array.isArray(result)
                ? { extra: undefined, items: result }
                : (result as { extra?: Partial<TExtra>; items: ReadonlyArray<T> });

            patchBase({ items, loading: false, status: "success" });

            if (patched !== undefined) {
                store.update(patched as Partial<ResourceState<T, TExtra>>);
            }
        } catch (error) {
            context.onError?.(error);
            patchBase({ error: mapAuthError(error, context.localization, context.localization.genericError), loading: false, status: "error" });
        }
    };

    const mutate = async (run: () => Promise<unknown>): Promise<void> => {
        if (store.get().busy) {
            return;
        }

        patchBase({ busy: true, error: undefined });

        try {
            await run();
            patchBase({ busy: false });
            await refetch();
        } catch (error) {
            context.onError?.(error);
            patchBase({ busy: false, error: mapAuthError(error, context.localization, context.localization.genericError), status: "error" });
        }
    };

    if (options.autoLoad !== false) {
        void refetch();
    }

    return {
        destroy: store.clear,
        getState: store.get,
        mutate,
        patch: (next: Partial<TExtra>) => {
            store.update(next as Partial<ResourceState<T, TExtra>>);
        },
        refetch,
        subscribe: store.subscribe,
    };
};

export type { ResourceHandle, ResourceOptions, ResourceState };
export { createResourceController };
