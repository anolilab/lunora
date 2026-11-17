/**
 * The `connect`-frame capability token a client sends to say it can hold the
 * frames between {@link BATCH_START_FRAME} and {@link BATCH_END_FRAME}, apply
 * them together, and notify its listeners once.
 *
 * Opt-in: a client that predates the bracket would apply each frame as it lands,
 * so its listeners could see one query updated by a write and another reading the
 * same table not yet — exactly what the bracket exists to hide. A client that never
 * announces it receives the frames unbracketed, as every client always has.
 */
const REFRESH_BATCH_CAPABILITY = "refreshBatch";

/** Opens the frames one write sends to one socket. */
const BATCH_START_FRAME = '{"type":"batchStart"}';

/** Closes them: the client applies everything it held since the start, then notifies. */
const BATCH_END_FRAME = '{"type":"batchEnd"}';

export { BATCH_END_FRAME, BATCH_START_FRAME, REFRESH_BATCH_CAPABILITY };
