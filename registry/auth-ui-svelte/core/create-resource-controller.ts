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

interface ResourceState<T> {
    /** A mutation (revoke, remove, …) is in flight. */
    busy: boolean;
    error?: string;
    items: ReadonlyArray<T>;
    /** The initial (or refetch) load is in flight. */
    loading: boolean;
    status: FlowStatus;
}

interface ResourceHandle<T> {
    destroy: () => void;
    getState: () => ResourceState<T>;
    /** Run a mutation, then refetch the list. Errors surface on `state.error`. */
    mutate: (run: () => Promise<unknown>) => Promise<void>;
    refetch: () => Promise<void>;
    subscribe: (onChange: () => void) => () => void;
}

interface ResourceOptions {
    /** Load immediately on creation (default true). */
    autoLoad?: boolean;
}

const createResourceController = <T>(
    context: ControllerContext,
    load: (context: ControllerContext) => Promise<ReadonlyArray<T>>,
    options: ResourceOptions = {},
): ResourceHandle<T> => {
    const store = createStore<ResourceState<T>>({ busy: false, items: [], loading: true, status: "idle" });

    const refetch = async (): Promise<void> => {
        store.update({ error: undefined, loading: true, status: "submitting" });

        try {
            const items = await load(context);

            store.update({ items, loading: false, status: "success" });
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.genericError), loading: false, status: "error" });
        }
    };

    const mutate = async (run: () => Promise<unknown>): Promise<void> => {
        if (store.get().busy) {
            return;
        }

        store.update({ busy: true, error: undefined });

        try {
            await run();
            store.update({ busy: false });
            await refetch();
        } catch (error) {
            context.onError?.(error);
            store.update({ busy: false, error: mapAuthError(error, context.localization, context.localization.genericError), status: "error" });
        }
    };

    if (options.autoLoad !== false) {
        void refetch();
    }

    return {
        destroy: () => {
            store.set({ busy: false, items: [], loading: false, status: "idle" });
        },
        getState: store.get,
        mutate,
        refetch,
        subscribe: store.subscribe,
    };
};

export type { ResourceHandle, ResourceOptions, ResourceState };
export { createResourceController };
