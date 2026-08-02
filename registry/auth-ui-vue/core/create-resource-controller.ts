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
 * `extra` is a slice of flow-specific state that must live in *this* store
 * rather than beside it — a search term, a total, a cursor.
 *
 * It exists because the alternative does not work: composing two stores means
 * `getState` builds a fresh object on every call, which silently breaks React's
 * `useSyncExternalStore` reference check. Keeping the extra fields here means
 * one snapshot, one stable reference, and no flow having to re-implement the
 * engine to carry two more properties.
 *
 * A nested field rather than an intersection: `Partial&lt;A & B>` is not assignable
 * from `{ busy: true }` while `B` is an unresolved generic, so an intersection
 * would need a cast at every internal update. Nesting keeps all of them honest.
 */
interface ResourceState<T, TExtra extends object = Record<never, never>> {
    /** A mutation (revoke, remove, …) is in flight. */
    busy: boolean;
    error?: string;
    /** Flow-specific state that has to share this snapshot. */
    extra: TExtra;
    items: ReadonlyArray<T>;
    /** The initial (or refetch) load is in flight. */
    loading: boolean;
    status: FlowStatus;
}

interface ResourceHandle<T, TExtra extends object = Record<never, never>> {
    destroy: () => void;
    getState: () => ResourceState<T, TExtra>;
    /** Run a mutation, then refetch the list. Errors surface on `state.error`. */
    mutate: (run: () => Promise<unknown>) => Promise<void>;

    /**
     * `mutate`, reporting whether it actually ran and succeeded.
     *
     * For callers that *act* on success — a navigation, say. They must not
     * re-read `state.error` instead: it is cleared at the start of every
     * attempt, and `mutate` is a silent no-op while another is in flight, so a
     * double-clicked button reads "fine" for a mutation that never happened.
     */
    mutateOk: (run: () => Promise<unknown>) => Promise<boolean>;

    /**
     * Merge into the flow-specific slice. Does not refetch — call `refetch` if
     * it changes the query.
     *
     * It writes into `state.extra`, so it cannot reach `busy`/`items`/`status`
     * even when handed a wider object than its parameter type describes.
     */
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
    load: (context: ControllerContext, extra: TExtra) => Promise<{ extra?: Partial<TExtra>; items: ReadonlyArray<T> }>,
    options: ResourceOptions<TExtra> = {},
): ResourceHandle<T, TExtra> => {
    const store = createStore<ResourceState<T, TExtra>>({
        busy: false,
        extra: options.initialExtra ?? ({} as TExtra),
        items: [],
        loading: true,
        status: "idle",
    });

    /*
     * Which `refetch` is current. A search box firing a query per keystroke can
     * have a slow answer for an early prefix land after a fast answer for the
     * full query — without a ticket, the stale prefix result would overwrite
     * the correct one an admin is already looking at. Mirrors
     * `createFormController.load`'s `generation`.
     */
    let generation = 0;

    const refetch = async (): Promise<void> => {
        generation += 1;

        const ticket = generation;

        store.update({ error: undefined, loading: true, status: "submitting" });

        try {
            const result = await load(context, store.get().extra);

            if (ticket !== generation) {
                return;
            }

            const { extra: patched, items } = result;

            store.update({ items, loading: false, status: "success" });

            if (patched !== undefined) {
                store.update({ extra: { ...store.get().extra, ...patched } });
            }
        } catch (error) {
            if (ticket !== generation) {
                return;
            }

            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.genericError), loading: false, status: "error" });
        }
    };

    const mutateOk = async (run: () => Promise<unknown>): Promise<boolean> => {
        if (store.get().busy) {
            return false;
        }

        store.update({ busy: true, error: undefined });

        try {
            await run();
            store.update({ busy: false });
            await refetch();

            return true;
        } catch (error) {
            context.onError?.(error);
            store.update({ busy: false, error: mapAuthError(error, context.localization, context.localization.genericError), status: "error" });

            return false;
        }
    };

    if (options.autoLoad !== false) {
        void refetch();
    }

    return {
        destroy: store.clear,
        getState: store.get,
        mutate: async (run: () => Promise<unknown>) => {
            await mutateOk(run);
        },
        mutateOk,
        patch: (next: Partial<TExtra>) => {
            store.update({ extra: { ...store.get().extra, ...next } });
        },
        refetch,
        subscribe: store.subscribe,
    };
};

export type { ResourceHandle, ResourceOptions, ResourceState };
export { createResourceController };
