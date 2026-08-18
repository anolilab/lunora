/**
 * Reactive sinks an adapter binds to its own primitive's setters (a React
 * `useState`, a Solid signal, a Vue ref, a Svelte store). The runner pushes into
 * them; how they store the value is the adapter's concern (e.g. Solid and React
 * wrap function-valued results in a thunk so the setter stores them rather than
 * invoking them).
 */
interface CallRunnerSinks<R> {
    /** Receives the normalized {@link Error} when the latest invocation rejects. */
    setError: (error: Error) => void;
    /** Receives `true` while at least one invocation is in flight (ref-counted across overlapping calls), else `false`. */
    setPending: (pending: boolean) => void;
    /** Receives the resolved value when the latest invocation succeeds. */
    setResult: (result: R) => void;
}

/**
 * Build the framework-neutral half of an adapter's write primitive — the `mutate`
 * of `useMutation`/`createMutation`/`mutation`, and the `call` of
 * `useAction`/`createAction`/`action`.
 *
 * It owns the orchestration every adapter otherwise copy-pastes: ref-counting
 * overlapping invocations into `setPending` (so the flag clears only once the
 * last settles), normalizing a thrown non-`Error`, and routing success/failure to
 * `setResult`/`setError` before re-throwing the SAME instance (so a typed error's
 * `.code`/`.data` survive for both the `catch` and the template).
 *
 * `invoke` is a pre-bound thunk — `(args, options) => client.mutation(fn, args, options)`
 * or `(args, options) => client.action(fn, args, options)`. Binding at the call
 * site is what keeps this one function: the runner never inspects `options`, it
 * only forwards them, so the option type is inferred from the closure rather
 * than hard-coded per procedure kind. What actually keeps `optimisticUpdate` off
 * an action is the adapter's exported handle type, not this file.
 *
 * `data`/`error` track the LATEST invocation, not the last to settle: overlapping
 * calls can resolve out of order, so an earlier call that finishes later must not
 * clobber a newer call's outcome. Each invocation takes a monotonic token and
 * writes the value sinks only while it is still the most recent one — otherwise a
 * double-click could leave the UI showing the first click's result, or an error
 * for a call that succeeded.
 */
const createCallRunner = <A, O, R>(invoke: (args: A, options?: O) => Promise<R>, sinks: CallRunnerSinks<R>): ((args: A, options?: O) => Promise<R>) => {
    // Ref-counted across overlapping calls of this one handle instance.
    let inFlight = 0;
    // Monotonic per-invocation token; only the latest may write `data`/`error`.
    let latestInvocation = 0;

    return async (args, options) => {
        latestInvocation += 1;

        const invocation = latestInvocation;

        inFlight += 1;
        sinks.setPending(true);

        try {
            const result = await invoke(args, options);

            if (invocation === latestInvocation) {
                sinks.setResult(result);
            }

            return result;
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));

            if (invocation === latestInvocation) {
                sinks.setError(normalized);
            }

            throw normalized;
        } finally {
            inFlight -= 1;
            sinks.setPending(inFlight > 0);
        }
    };
};

export type { CallRunnerSinks };
export { createCallRunner };
