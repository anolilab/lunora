import { foldOptimistic,notifySubscription } from "./optimistic-layers";
import type { SubscriptionState } from "./subscription";
import type { ServerDataMessage } from "./types";

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
export const fanCheckpoints = (state: SubscriptionState, options: { rowsFollow?: true } = {}): void => {
    for (const onCheckpoint of state.checkpointCallbacks) {
        onCheckpoint({
            checkpoint: state.serverCursor,
            mutationId: state.lastMutationId,
            ...(options.rowsFollow === true && { rowsFollow: true }),
        });
    }
};

/**
 * Commit a data frame's authoritative payload and its position. The caller has
 * already resolved the payload, so this only records it. The payload becomes the
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

    if (message.lastMutationId !== undefined) {
        advanceWatermark(state, message.lastMutationId);
        fanCheckpoints(state, { rowsFollow: true });
    }
};

/**
 * Display the authoritative base, re-folded through whatever optimistic layers are
 * still pending, so a layer that is still pending keeps showing its write.
 */
export const refoldAndNotify = (state: SubscriptionState): void => {
    notifySubscription(state, foldOptimistic(state.serverBase, state.optimisticLayers));
};
