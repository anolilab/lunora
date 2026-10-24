import { LunoraError } from "@lunora/errors";

/** What a {@link MailSendError} carries on `data`, so a caller can tell a retry from a refusal. */
interface MailSendErrorData {
    /** Whether repeating the same message may succeed. A refused address or malformed message never will. */
    retryable: boolean;
}

/**
 * A send that did not deliver. `retryable` is the decision a queue consumer
 * needs: a provider outage or rate limit may clear on a redelivery, while a
 * refused recipient or a rejected message will fail the same way every time.
 * Retrying the latter only drains the queue into its dead-letter queue.
 */
class MailSendError extends LunoraError {
    public readonly retryable: boolean;

    public constructor(options: { cause?: unknown; message?: string; retryable: boolean }) {
        const data: MailSendErrorData = { retryable: options.retryable };

        super("INTERNAL", options.message ?? "@lunora/mail: send failed", { cause: options.cause, data, name: "MailSendError" });

        this.retryable = options.retryable;
    }
}

/**
 * Whether a failed send is worth a queue redelivery. Only an error the mail
 * path classified as retryable qualifies. Everything else, including the
 * shape-check refusals `consumeQueuedSend` throws before any provider call, is
 * a message that will never send.
 */
const isRetryableMailError = (error: unknown): boolean => error instanceof MailSendError && error.retryable;

export { isRetryableMailError, MailSendError };
export type { MailSendErrorData };
