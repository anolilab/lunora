import { readField } from "./common";

/**
 * How long an open call may sit unreported before the next `open` sweeps it out.
 * Generous enough that no real generation is ever evicted mid-flight, short
 * enough that an abandoned entry — which holds the call's prompt — does not
 * outlive the isolate's next few turns. See {@link createInFlightCalls}.
 */
const ABANDONED_CALL_MS = 10 * 60 * 1000;

/**
 * The bookkeeping every telemetry bridge needs to time a model call correctly:
 * a `callId`-keyed registry of calls that are OPEN, closed by whichever terminal
 * event the SDK fires first.
 *
 * **Why a registry rather than wrapping `execute()`.** A bridge that opens and
 * closes around `executeLanguageModelCall` measures the wrong thing on a stream:
 * `execute()` resolves the instant `doStream` hands the stream back — before a
 * token, before any usage, before any mid-stream failure — so every streamed turn
 * reports as a ~1 ms, zero-token, always-OK call. The call is only really over at
 * `onLanguageModelCallEnd` (after the stream's `finish` part, where the duration
 * and the token usage both live), at `onAbort` / `onError`, or at an in-band
 * `{ type: "error" }` stream part. Those arrive as separate callbacks, so the
 * per-call state has to survive between them.
 *
 * **Every close is addressed by `callId`, never in bulk.** A telemetry
 * integration is commonly built once at module scope — the documented
 * `defineAgent({ telemetry: { integrations: [otlpTelemetry(...)] } })` shape does
 * exactly that — so ONE registry is shared by every concurrent agent run in the
 * isolate. A bulk "close everything still open" on abort would let run A's
 * barge-in report run B's live generation as an aborted failure and swallow B's
 * real span. Every ai@7 terminal event carries the model call's `callId`
 * (verified against ai@7.0.59, `onAbort` and `onError` included), so there is no
 * need to guess: an event without one closes nothing.
 *
 * `T` is whatever the bridge needs to carry from open to close — an attribute
 * bag, a host span handle, a `log()`-able span. See the three callers.
 */
export interface InFlightCalls<T> {
    /**
     * Report one call and forget it. A `callId` that is no longer open has already
     * been reported (an error followed by a late end event) and is dropped rather
     * than double-counted.
     */
    close: (callId: string, ok: boolean, message: string | undefined, event: unknown) => void;

    /**
     * Close a call that is still open when the SDK reports the step, or the whole
     * operation, finished (`onEnd` / `onStepEnd`).
     *
     * A provider that reports a mid-stream failure the protocol way — an in-band
     * `{ type: "error" }` part — never produces a model-call-end event, so this is
     * the only signal that the call is over, and `finishReason: "error"` is the
     * only thing that says it failed. A no-op once the call has already closed.
     */
    fromLifecycle: (event: unknown) => void;

    /** The open call's carried value, so a bridge can amend it before it closes. */
    get: (callId: string) => T | undefined;

    /**
     * Open a call unless one is already open under this `callId` — both
     * `executeLanguageModelCall` and `onLanguageModelCallStart` may fire for the
     * same call, and only the first wins.
     */
    open: (callId: string, create: () => T) => void;
}

/**
 * Build an {@link InFlightCalls} registry. `onClose` is invoked exactly once per
 * call, with the value `open` created and whichever terminal event closed it
 * (`undefined` when the call was closed by a rejection).
 *
 * **The one call that never closes.** A stream that REJECTS outright —
 * `controller.error(...)`, i.e. a socket that dies mid-generation — dispatches no
 * telemetry callback at all in ai@7.0.59: not `onError`, not `onAbort`, not
 * `onEnd`. (The same failure reported the protocol way, as an in-band
 * `{ type: "error" }` part, does reach `fromLifecycle` and is reported normally.)
 * Such a call is never closed, so it reports no span rather than a false success
 * — and, left alone, it would pin its prompt in memory for as long as the
 * integration lives. Each `open` therefore sweeps out anything older than
 * {@link ABANDONED_CALL_MS}. Swept entries are DROPPED, not emitted: a span whose
 * end time is "whenever the next call happened to start" is worse than no span.
 *
 * Dropping the RECORD is not the same as dropping the resource. A carried value
 * may own something live in the host SDK — Sentry's `startSpanManual` span, the
 * promise Braintrust's `traced` callback is parked on — and deleting the entry
 * strands it exactly as the abandoned call itself would have. `onEvict` is where
 * a bridge releases that, without emitting anything.
 * @param onClose Emit the bridge's span/record for one finished call.
 * @param onEvict Release a swept call's host-SDK resource. No span is emitted.
 */
export const createInFlightCalls = <T>(
    onClose: (call: T, ok: boolean, message: string | undefined, event: unknown) => void,
    onEvict?: (call: T) => void,
): InFlightCalls<T> => {
    const inFlight = new Map<string, { call: T; openedAt: number }>();

    const close = (callId: string, ok: boolean, message: string | undefined, event: unknown): void => {
        const entry = inFlight.get(callId);

        if (entry === undefined) {
            return;
        }

        inFlight.delete(callId);

        onClose(entry.call, ok, message, event);
    };

    return {
        close,
        fromLifecycle: (event: unknown): void => {
            const callId = readField(event, "callId");

            if (typeof callId !== "string" || !inFlight.has(callId)) {
                return;
            }

            // `finishReason` is the unified string on the lifecycle events, but the
            // provider protocol's own shape is `{ unified, raw }` — read both so a
            // failure is never rounded up to a success by an event shape.
            const finishReason = readField(event, "finishReason");
            const failed = finishReason === "error" || readField(finishReason, "unified") === "error";

            close(callId, !failed, failed ? "the model call ended with an error" : undefined, event);
        },
        get: (callId: string): T | undefined => inFlight.get(callId)?.call,
        open: (callId: string, create: () => T): void => {
            const cutoff = Date.now() - ABANDONED_CALL_MS;

            // A Map iterator tolerates deletion of the entry it just yielded.
            for (const [openCallId, entry] of inFlight) {
                if (entry.openedAt < cutoff) {
                    inFlight.delete(openCallId);
                    onEvict?.(entry.call);
                }
            }

            if (inFlight.has(callId)) {
                return;
            }

            inFlight.set(callId, { call: create(), openedAt: Date.now() });
        },
    };
};
