/**
 * Transient error messages for the flows that have nowhere to put one.
 *
 * Most flows own a card, and a card owns a `<FormBanner>` — that is where their
 * errors belong, and this store deliberately does not duplicate them. What it
 * exists for is the handful of actions with **no visible surface at the moment
 * they fail**: social sign-in and account linking (a redirect that never
 * happens), sign-out, anonymous sign-in. Those call `context.onError` and then
 * resolve, so today a failure is a page that simply does nothing.
 *
 * `<ErrorToaster>` renders whatever lands here. Mounting it is opt-in; an app
 * with its own toast system reads the same store instead, or keeps passing
 * `onError` and ignores this entirely.
 */
import { createStore } from "./store";

interface Toast {
    /** Monotonic, so a view can key a list without a random id. */
    id: number;
    message: string;
}

interface ToastState {
    toasts: ReadonlyArray<Toast>;
}

/**
 * Module-level, like `discovery.ts`: `<ErrorToaster>` is mounted once in an app
 * shell while the flows that push to it live anywhere in the tree, so a
 * per-provider store would need threading through every controller to reach it.
 */
const store = createStore<ToastState>({ toasts: [] });

let nextId = 0;

/** How long a toast stays up before dismissing itself. */
const TOAST_DURATION_MS = 6000;

/** Timers by toast id, so `dismissToast` can cancel one that is dismissed early. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const dismissToast = (id: number): void => {
    const timer = timers.get(id);

    if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(id);
    }

    store.update({ toasts: store.get().toasts.filter((toast) => toast.id !== id) });
};

/**
 * Show `message`. Returns the id so a caller can dismiss it early.
 *
 * Identical consecutive messages collapse: a user who clicks a broken social
 * button three times should see one toast, not three.
 */
const pushToast = (message: string): number => {
    const current = store.get().toasts;
    const last = current.at(-1);

    if (last?.message === message) {
        return last.id;
    }

    nextId += 1;

    const toast: Toast = { id: nextId, message };

    store.update({ toasts: [...current, toast] });

    // `setTimeout` is guarded rather than assumed: this module is imported by
    // SSR bundles, where nothing will ever render the toast anyway.
    if (typeof setTimeout === "function") {
        timers.set(
            toast.id,
            setTimeout(() => {
                dismissToast(toast.id);
            }, TOAST_DURATION_MS),
        );
    }

    return toast.id;
};

const getToasts = (): ReadonlyArray<Toast> => store.get().toasts;

const subscribeToasts = (onChange: () => void): (() => void) => store.subscribe(onChange);

/** Test seam: drop every toast and its timer. */
const resetToasts = (): void => {
    for (const timer of timers.values()) {
        clearTimeout(timer);
    }

    timers.clear();
    store.set({ toasts: [] });
};

export type { Toast, ToastState };
export { dismissToast, getToasts, pushToast, resetToasts, subscribeToasts, TOAST_DURATION_MS };
