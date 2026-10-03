/**
 * "That username is taken" — before the submit, not after it.
 *
 * better-auth's `username` plugin exposes `/is-username-available`, which
 * nothing here used: the first time a user learned their choice was taken was
 * when the whole sign-up failed, with the rest of the form to re-check.
 *
 * # Why this is debounced, and why the answer can be discarded
 *
 * It fires per keystroke, so it is debounced — an availability check on every
 * character is a request per character. And because requests can land out of
 * order, each one records the value it was asking about: a slow answer for
 * `ada` must not overwrite a fast answer for `adalovelace`, which is how these
 * end up confidently reporting the wrong thing.
 *
 * The result is advisory. It is a courtesy check against a race it cannot win —
 * the name can be taken between the check and the submit — so the server stays
 * the authority and a failed check never blocks a submit on its own.
 */
import type { ControllerContext } from "./config";
import { createStore } from "./store";
import type { Controller } from "./types";

type AvailabilityStatus = "available" | "checking" | "idle" | "taken" | "unknown";

interface UsernameAvailabilityState {
    status: AvailabilityStatus;
    /** The value the current status describes. */
    username: string;
}

interface UsernameAvailabilityActions {
    /** Feed the field's current value. Debounced internally. */
    check: (username: string) => void;
    reset: () => void;
}

type UsernameAvailabilityController = Controller<UsernameAvailabilityState, UsernameAvailabilityActions>;

interface UsernameAvailabilityOptions {
    /** Milliseconds to wait after the last keystroke. Defaults to 400. */
    debounceMs?: number;
    /** Don't ask about anything shorter than this. Defaults to 3. */
    minLength?: number;
}

const createUsernameAvailabilityController = (context: ControllerContext, options: UsernameAvailabilityOptions = {}): UsernameAvailabilityController => {
    const store = createStore<UsernameAvailabilityState>({ status: "idle", username: "" });
    const debounceMs = options.debounceMs ?? 400;
    const minLength = options.minLength ?? 3;

    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The value of the most recent request, so a stale answer can be dropped. */
    let inFlight = "";

    const clearTimer = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const ask = async (username: string): Promise<void> => {
        inFlight = username;
        store.set({ status: "checking", username });

        try {
            const response = await context.authClient.isUsernameAvailable({ username });

            // Dropped rather than applied: a slower request for an earlier value
            // must not overwrite the answer for what is in the field now.
            if (inFlight !== username) {
                return;
            }

            if (response.error) {
                store.set({ status: "unknown", username });

                return;
            }

            store.set({ status: response.data?.available === false ? "taken" : "available", username });
        } catch (error) {
            context.onError?.(error);

            if (inFlight === username) {
                // "unknown", not "taken": a failed check is not evidence against
                // the name, and must not block a sign-up the server would allow.
                store.set({ status: "unknown", username });
            }
        }
    };

    return {
        actions: {
            check: (username: string) => {
                const trimmed = username.trim();

                clearTimer();

                if (trimmed.length < minLength) {
                    inFlight = "";
                    store.set({ status: "idle", username: trimmed });

                    return;
                }

                if (typeof setTimeout !== "function") {
                    void ask(trimmed);

                    return;
                }

                timer = setTimeout(() => {
                    void ask(trimmed);
                }, debounceMs);
            },
            reset: () => {
                clearTimer();
                inFlight = "";
                store.set({ status: "idle", username: "" });
            },
        },
        destroy: () => {
            clearTimer();
            store.clear();
        },
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { AvailabilityStatus, UsernameAvailabilityActions, UsernameAvailabilityController, UsernameAvailabilityOptions, UsernameAvailabilityState };
export { createUsernameAvailabilityController };
