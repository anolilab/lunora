"use client";

import type { ActionCallOptions, ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { createCallRunner } from "@lunora/client";
import { useMutation as useTanStackMutation } from "@tanstack/react-query";
import { useState } from "react";

import { useLunora } from "./lunora-provider";

type CallVariables<F extends FunctionReference> = { args: ArgsOf<F>; options?: ActionCallOptions };

interface ActionHook<F extends FunctionReference> {
    /**
     * Invoke the action. Awaitable, and rejects on failure — the same contract
     * as `useMutation`'s `mutate`.
     */
    call: (args: ArgsOf<F>, options?: ActionCallOptions) => Promise<ReturnOf<F>>;
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: ReturnOf<F> | undefined;
    /** The latest invocation's error, or `undefined`. */
    error: Error | undefined;
    /** `true` while ANY invocation from this hook is in flight (ref-counted, so overlapping calls compose). */
    pending: boolean;
    /** Clear the latest `data`/`error` back to idle. */
    reset: () => void;
}

/**
 * Returns `{ call, pending, data, error, reset }` for the given action reference.
 * Prefer destructuring at the call site so the React linter can track
 * dependencies on each field independently.
 *
 * Actions were the one procedure kind with no hook: `useQuery` and `useMutation`
 * shipped, so every app that called an action reached for `useLunora()` and
 * re-derived the same pending/error wrapper by hand. This is that wrapper, once.
 *
 * The request state machine is the shared `createCallRunner` from
 * `@lunora/client` — the same one Vue, Solid and Svelte bind to their own
 * primitives — so `pending`, error normalization and latest-invocation ordering
 * behave identically in every adapter. Only the `useState` cells are React's.
 * TanStack's mutation cache still carries the call so it shows up in Query
 * Devtools alongside `useQuery`/`useMutation`.
 *
 * **Lifecycle contract** (identical across the adapters): `data` and `error`
 * both track the LATEST invocation, not the last to settle — a double-click
 * whose first call resolves after the second cannot overwrite the second's
 * outcome. A success clears `error`; a failure leaves the previous `data` in
 * place, so a transient error does not blank the view. `reset()` clears both,
 * but does NOT cancel an in-flight call, whose result still lands.
 *
 * **Why the two TanStack defaults are overridden.** `networkMode` is `"always"`
 * because the default `"online"` pauses the retryer *after* the call is already
 * marked pending: offline, the promise would never settle, the spinner would
 * stick, and the action would silently fire minutes later on reconnect. `retry`
 * is pinned to `0` — not inherited from an app-supplied QueryClient — because
 * `client.action` sends no idempotency key, so a retry after a 502 on an action
 * that already ran server-side would run it a second time. A mutation may pause
 * and retry safely; it carries a `mutationId` and an offline queue. An action
 * carries neither.
 *
 * **What it deliberately does not carry.** There is no `optimistic` /
 * `optimisticUpdate` and no `withOptimisticUpdate`, which `useMutation` has. An
 * optimistic update patches the subscription cache on the assumption the write
 * will land; an action is not a write — it runs in the Worker, may call a third
 * party, and has no declared effect on any query. Offering the option would
 * imply a rollback guarantee nothing can honour.
 *
 * ```tsx
 * const { call: runCommand, pending } = useAction(api.commands.run);
 *
 * await runCommand({ command: "lunora", args: ["verify"] });
 * ```
 */
const useAction = <F extends FunctionReference>(function_: F): ActionHook<F> => {
    const client = useLunora();

    const [data, setData] = useState<ReturnOf<F> | undefined>(undefined);
    const [error, setError] = useState<Error | undefined>(undefined);
    const [pending, setPending] = useState(false);

    const { mutateAsync, reset: resetMutation } = useTanStackMutation<ReturnOf<F>, Error, CallVariables<F>>({
        mutationFn: async ({ args, options }) => client.action(function_, args, options),
        // See the "why the two TanStack defaults are overridden" note above.
        networkMode: "always",
        retry: 0,
    });

    // One runner per hook instance, built lazily so its in-flight ref-count and
    // latest-invocation token survive re-renders. `mutateAsync` and `reset` are
    // bound once by TanStack's MutationObserver and read the *current* options
    // on each call, so capturing them here is safe and needs no memo deps.
    const [{ call, reset }] = useState(() => {
        return {
            call: createCallRunner(async (args: ArgsOf<F>, options?: ActionCallOptions) => mutateAsync({ args, options }), {
                setError,
                setPending,
                setResult: (result) => {
                    // Wrap in a thunk so a function-valued server result is stored,
                    // not mistaken for a `useState` updater and invoked.
                    setData(() => result);
                    setError(undefined);
                },
            }),
            reset: (): void => {
                setData(undefined);
                setError(undefined);
                // Clear TanStack's own cache entry too, so Devtools doesn't keep
                // showing a result the hook has already discarded.
                resetMutation();
            },
        };
    });

    return { call, data, error, pending, reset };
};

export type { ActionHook };
export { useAction };
