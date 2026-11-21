/**
 * Thrown by an {@link import("./types").OutboxSink}'s `enqueue` that cannot store
 * a write durably right now — `@lunora/db`'s sink in a tab that does not lead
 * the outbox, where the executor would run the write once, unstored, and drop it
 * on a transient failure. The client keeps the write in its built-in offline
 * queue instead. A kind rather than a `code`: it never reaches the app.
 */
class OutboxDeclinedError extends Error {
    public constructor(message = "the outbox cannot store this write durably") {
        super(message);
        this.name = "OutboxDeclinedError";
    }
}

export default OutboxDeclinedError;
