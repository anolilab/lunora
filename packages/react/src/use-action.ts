"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { useMutation as useTanStackMutation } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { useLunora } from "./lunora-provider";

/** Per-call options for {@link ActionHook.call}. */
interface UseActionCallOptions {
    /** Route the call to a specific shard, matching `client.action`'s option. */
    shardKey?: string;
}

type CallVariables<F extends FunctionReference> = { args: ArgsOf<F>; options?: UseActionCallOptions };

interface ActionHook<F extends FunctionReference> {
    /**
     * Invoke the action. Awaitable, and rejects on failure — the same contract
     * as `useMutation`'s `mutate`.
     */
    call: (args: ArgsOf<F>, options?: UseActionCallOptions) => Promise<ReturnOf<F>>;
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: ReturnOf<F> | undefined;
    /** The latest invocation's error, or `null`. */
    error: Error | null;
    /** `true` when the latest invocation rejected. */
    isError: boolean;
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
 * Built on TanStack Query's mutation cache (the same cache the query and
 * mutation hooks use), so it composes with Query Devtools and exposes the latest
 * call's `data`/`error` plus `reset()`. `pending` is ref-counted across
 * overlapping invocations of THIS hook instance, so it clears only once every
 * concurrent call has settled, and a sibling component calling the same action
 * never affects it.
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

    // Local, ref-counted pending across overlapping calls of this hook instance.
    const pendingCountReference = useRef(0);
    const [pending, setPending] = useState(false);

    const action = useTanStackMutation<ReturnOf<F>, Error, CallVariables<F>>({
        mutationFn: async ({ args, options }) => client.action(function_, args, options),
        // `onMutate` fires when a call starts, `onSettled` when it resolves or
        // rejects — so overlapping calls compose and `pending` only clears once
        // the last one settles.
        onMutate: () => {
            pendingCountReference.current += 1;
            setPending(true);
        },
        onSettled: () => {
            pendingCountReference.current -= 1;
            setPending(pendingCountReference.current > 0);
        },
    });

    // `mutateAsync`/`reset` are referentially stable across renders.
    const { data, error, isError, mutateAsync, reset } = action;

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing, same as `useMutation`'s `mutate`: React Compiler bails this hook, so this `useCallback` is what keeps `call` referentially stable for consumers that place it in effect deps. Keep it.
    const call = useCallback(async (args: ArgsOf<F>, options?: UseActionCallOptions): Promise<ReturnOf<F>> => mutateAsync({ args, options }), [mutateAsync]);

    return { call, data, error, isError, pending, reset };
};

export type { ActionHook, UseActionCallOptions };
export { useAction };
