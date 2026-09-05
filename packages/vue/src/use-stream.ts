import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import type { MaybeRefOrGetter, Ref } from "vue";
import { onScopeDispose, ref, toValue, watch } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { useLunora } from "./lunora-provider";

/** The lifecycle of a stream the composable is observing. */
type UseStreamStatus = "complete" | "error" | "idle" | "streaming";

interface UseStreamResult<T> {
    /** Force-cancel the stream and resolve the iterator. Safe to call multiple times. */
    cancel: () => void;
    /** Chunks the server has pushed so far, in arrival order. */
    chunks: Ref<ReadonlyArray<T>>;
    error: Ref<Error | undefined>;
    status: Ref<UseStreamStatus>;
}

interface UseStreamOptions {
    /**
     * Opt into resume-on-reconnect for a stream the server declared `durable`.
     * The chunks already received are kept and the socket re-attaches to the same
     * run, so a dropped connection mid-generation continues instead of surfacing
     * `STREAM_DISCONNECTED`. Has no effect on an ephemeral stream.
     */
    durable?: boolean;
    /** Forwarded to `client.stream()` — caps the in-flight chunk buffer. */
    maxBuffer?: number;
    shardKey?: string;
}

/**
 * Subscribe to a streaming query. Returns the chunks pushed so far plus a
 * lifecycle status and a cancel function, all as refs. Changing the resolved
 * `args` resets the stream — the previous iterator is cancelled and a fresh one
 * opens with empty `chunks`.
 *
 * `args` may be a plain value, `ref`, or getter; resolving it to `"skip"` keeps
 * the composable mounted without opening a stream (mirrors `useSubscription`).
 * Nothing opens during SSR either — the stream attaches after hydration.
 * The Vue counterpart to React's `useStream`, re-expressed with refs.
 */
const useStream = <F extends FunctionReference<"stream">>(
    function_: F,
    args: MaybeRefOrGetter<"skip" | ArgsOf<F>>,
    options: UseStreamOptions = {},
): UseStreamResult<ReturnOf<F>> => {
    const client = useLunora();
    const chunks = ref<ReadonlyArray<ReturnOf<F>>>([]) as Ref<ReadonlyArray<ReturnOf<F>>>;
    const error = ref<Error | undefined>(undefined);
    const status = ref<UseStreamStatus>("idle");

    // The live cancel handle for the currently-open stream, so a manual `cancel()`
    // and the watcher's cleanup call into the same function.
    let cancelCurrent: (() => void) | undefined;

    const cancel = (): void => {
        cancelCurrent?.();
    };

    watch(
        () => toValue(args),
        (currentArgs, _previous, onCleanup) => {
            // Reset for the new (or torn-down) stream.
            chunks.value = [];
            error.value = undefined;

            // Client-only: an `immediate: true` watcher fires once during
            // `renderToString` with no unmount to run `onCleanup` (see
            // `use-presence.ts`'s guard rationale) — a stream opened there is
            // held for the life of the server process. Leave the refs inert.
            if (currentArgs === "skip" || !isBrowser()) {
                status.value = "idle";

                return;
            }

            status.value = "streaming";

            let active = true;
            const iterable = client.stream(function_, currentArgs, { durable: options.durable, maxBuffer: options.maxBuffer, shardKey: options.shardKey });
            const cancelIterable = (): void => {
                iterable.cancel();
            };

            cancelCurrent = cancelIterable;

            // Consume in a background async IIFE so the watcher body stays
            // synchronous; the cancel handle is what the cleanup uses. The IIFE
            // owns its own try/catch so any error already lands in the refs; the
            // trailing `.catch` is a belt-and-braces guard that can never fire.
            (async () => {
                try {
                    for await (const chunk of iterable) {
                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` is flipped to `false` by the cleanup closure between awaits; TS's static flow analysis can't see the async mutation, so this guard is real, not dead.
                        if (!active) {
                            return;
                        }

                        // Append immutably so consumers comparing by identity see a change.
                        chunks.value = [...chunks.value, chunk];
                    }

                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by the cleanup closure while the iterator was awaiting; the guard is real, not dead.
                    if (active) {
                        status.value = "complete";
                    }
                } catch (streamError: unknown) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by the cleanup closure while the iterator was awaiting; the guard is real, not dead.
                    if (!active) {
                        return;
                    }

                    error.value = streamError instanceof Error ? streamError : new Error(String(streamError));
                    status.value = "error";
                }
            })().catch(() => {
                // Unreachable: the IIFE's own try/catch already routes errors into
                // the refs. This satisfies no-floating-promises.
            });

            onCleanup(() => {
                active = false;
                cancelIterable();

                if (cancelCurrent === cancelIterable) {
                    cancelCurrent = undefined;
                }
            });
        },
        { immediate: true },
    );

    onScopeDispose(() => {
        cancel();
    });

    return { cancel, chunks, error, status };
};

export type { UseStreamOptions, UseStreamResult, UseStreamStatus };
export { useStream };
