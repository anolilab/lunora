import { LunoraError } from "@lunora/errors";

/** What a {@link MailSendError} carries on `data`, so a caller can tell a retry from a refusal. */
interface MailSendErrorData {
    /**
     * The send was cut off before the provider answered (the mailer's send deadline, or the
     * provider's own request timeout), so it may have been delivered. Always paired with
     * `retryable: false`: repeating it risks a second copy.
     */
    outcomeUnknown: boolean;
    /** Whether repeating the same message may succeed. A refused address or malformed message never will. */
    retryable: boolean;
}

/**
 * A send that did not deliver. `retryable` is the decision a queue consumer
 * needs: a send is a refusal only when the provider answered with an explicit
 * permanent HTTP status (anything but 408, 429 and 5xx); every other failure may
 * clear on a redelivery. Retrying a refusal only drains the queue into its
 * dead-letter queue.
 *
 * A send that timed out is neither: the provider may have accepted it, so it is
 * `outcomeUnknown` and never `retryable` — a queue consumer acks and reports it
 * rather than mailing the recipient a second copy.
 */
class MailSendError extends LunoraError {
    public readonly outcomeUnknown: boolean;

    public readonly retryable: boolean;

    public constructor(
        options:
            | { cause?: unknown; message?: string; outcomeUnknown: true; retryable: false }
            | { cause?: unknown; message?: string; outcomeUnknown?: false; retryable: boolean },
    ) {
        const outcomeUnknown = options.outcomeUnknown ?? false;
        const data: MailSendErrorData = { outcomeUnknown, retryable: options.retryable };

        super("INTERNAL", options.message ?? "@lunora/mail: send failed", { cause: options.cause, data, name: "MailSendError" });

        this.outcomeUnknown = outcomeUnknown;
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

/**
 * Whether a failed send may nonetheless have been delivered — it timed out
 * before the provider answered. Report it (and check the provider's logs);
 * do not resend it.
 */
const isOutcomeUnknownMailError = (error: unknown): boolean => error instanceof MailSendError && error.outcomeUnknown;

export { isOutcomeUnknownMailError, isRetryableMailError, MailSendError };
export type { MailSendErrorData };
