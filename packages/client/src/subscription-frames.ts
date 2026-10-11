import type { SubscriptionState } from "./subscription";
import type { ServerDataMessage, ServerErrorMessage } from "./types";

/**
 * Advance a subscription's custom-mutator watermark. `Math.max`, never a bare
 * assignment: the server's watermark restarts from a lower value when its
 * `__client_watermark` row is reset (a recycled DO, a PITR restore), and a bare
 * assignment would walk the checkpoint gate backwards and re-open an overlay a
 * later frame had already confirmed.
 */
export const advanceWatermark = (state: SubscriptionState, mutationId: number): void => {
    // eslint-disable-next-line no-param-reassign -- the watermark is the subscription's own state
    state.lastMutationId = Math.max(state.lastMutationId ?? 0, mutationId);
};

/**
 * Fan the current checkpoint out to every subscriber of a shared state. A data
 * frame passes `rowsFollow`, because its rowset callback runs right after. A settled
 * frame does not: its value did not change, so no rows follow.
 */
export const fanCheckpoints = (state: SubscriptionState, rowsFollow = false): void => {
    for (const onCheckpoint of state.checkpointCallbacks) {
        onCheckpoint({
            checkpoint: state.serverCursor,
            mutationId: state.lastMutationId,
            ...(rowsFollow && { rowsFollow: true }),
        });
    }
};

/**
 * Record a data frame's authoritative payload and its position. The caller has already
 * resolved the payload. The watermark and the checkpoint fan-out are the caller's to run,
 * so this function has no effect on subscribers. The payload becomes the
 * new `serverBase`, and the cursor and epoch advance when the frame carries them.
 */
export const commitDataFrame = (state: SubscriptionState, message: ServerDataMessage, payload: unknown): void => {
    /* eslint-disable no-param-reassign -- commit the shared subscription state in place */
    state.serverBase = payload;

    if (message.cursor !== undefined) {
        state.serverCursor = message.cursor;
    }

    if (message.epoch !== undefined) {
        state.serverEpoch = message.epoch;
    }
    /* eslint-enable no-param-reassign */
};

/** Where an `error` frame belongs. Decided from the frame and what the client holds, never from the socket. */
export type ErrorFrameRoute = "none" | "shape" | "stream" | "subscription" | "tokenExpired";

/**
 * Route an `error` frame. A token expiry is a socket-wide notice, so it wins over any
 * id. Otherwise the frame goes to the first owner of its id, in the order streams,
 * then subscriptions, then shapes. A frame with no id that is not a token expiry has no
 * owner.
 */
export const routeErrorFrame = (message: ServerErrorMessage, held: { shape: boolean; stream: boolean; subscription: boolean }): ErrorFrameRoute => {
    if ((message.error as { code?: unknown } | undefined)?.code === "TOKEN_EXPIRED") {
        return "tokenExpired";
    }

    if (message.id === undefined) {
        return "none";
    }

    if (held.stream) {
        return "stream";
    }

    if (held.subscription) {
        return "subscription";
    }

    return held.shape ? "shape" : "none";
};
