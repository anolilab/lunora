import type { ReactElement } from "react";

/**
 * Minimal projection of a Cloudflare Queue binding — accepts a JSON payload
 * via `.send()`. Declared structurally so callers can pass either the real
 * `Queue` binding or a unit-test double.
 */
export interface QueueLike {
    send: (payload: unknown, options?: Record<string, unknown>) => Promise<void>;
}

/**
 * Minimal projection of a transport adapter. Returning `{ id }` follows
 * Resend's response shape; the real `@visulima/email` `MailManager` flattens
 * provider responses to the same field for us.
 */
export interface MailTransport {
    /**
     * The provider drops a repeat of a send carrying the same `idempotencyKey`, so a
     * send that may have landed is safe to retry when it carried one. Set only by a
     * transport that forwards the key to such a provider (the Resend transport).
     *
     * A transport reports a send that may have landed by throwing
     * `MailSendError({ outcomeUnknown: true, retryable: false })` and leaves the
     * retry decision to `createMailer`'s `send()`, which makes it retryable when this
     * flag is set and the send had a key, and not retryable otherwise, whatever the
     * transport said.
     */
    dedupesOnIdempotencyKey?: boolean;

    /**
     * `options.idempotencyKey` is the send's stable dedupe key, when it has one. A
     * transport whose provider dedupes on a key forwards it (the Resend transport
     * sends it as the `Idempotency-Key` request header); others ignore it. It is
     * never a message header.
     */
    send: (payload: SendPayload, options?: { idempotencyKey?: string }) => Promise<{ id: string }>;
}

export interface SendPayload {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

export interface SendOptions {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;

    /**
     * Stable key for deduping a send across retries and Cloudflare Queues'
     * at-least-once redelivery: 1-256 visible ASCII characters, other than `.` and
     * `..` (Workers KV refuses both as key names). When omitted,
     * `queue()` generates one at enqueue time so it survives redelivery (a key
     * minted in the consumer would change on every retry, defeating the point).
     * `consumeQueuedSend` dedupes on it when given a `sent` store, and the transport
     * receives it: Resend dedupes on it as the `Idempotency-Key` request header, while
     * the Cloudflare binding has no such hook and ignores it. See
     * `consumeQueuedSend` for why that is a narrowed at-least-once rather than
     * exactly-once.
     *
     * A key names one message, not one recipient: Resend never delivers a repeat
     * of it within 24 hours, so a key reused for a new message
     * (`verify:${userId}`) loses that message.
     */
    idempotencyKey?: string;
    react?: ReactElement;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

export interface LunoraMailOptions {
    /** API key for the Resend transport (bring-your-own-provider). Ignored when `transport` or `cloudflareSend` is set. */
    apiKey?: string;

    /**
     * RFC 822 send callback bound to the Worker's `send_email` binding. When set
     * (and no explicit `transport` is supplied) the default transport is
     * Cloudflare Email Workers — Lunora's default provider. Ignored when
     * `transport` is set.
     */
    cloudflareSend?: (from: string, to: string, raw: string) => Promise<void>;
    /** Default sender (`Name <addr@host>` or bare email). */
    from: string;
    /** Default queue binding for `mailer.queue()`. */
    queue?: QueueLike;

    /**
     * How long `send()` waits for the transport before giving up, in milliseconds
     * (default 60 000). A send cut off here may still have been delivered, so it
     * fails with an `outcomeUnknown` `MailSendError`. It is retryable only when the
     * send carried an `idempotencyKey` and the transport's provider dedupes on it
     * (Resend); otherwise a queue consumer acks and reports it instead of
     * redelivering a possible duplicate. The transport's own work is not
     * cancelled — the Cloudflare binding and the provider client take no abort
     * signal.
     *
     * Resend's HTTP client has its own clock: it aborts each request after 30
     * seconds (`ETIMEDOUT`, outcome-unknown the same way and never repeated by the
     * client) and repeats a 408, 429 or 503 up to three times, so one Resend send
     * can keep running for about two minutes after this deadline has failed it.
     */
    sendTimeoutMs?: number;
    /** Override the underlying transport. Useful for tests, the dev capture transport, + multi-provider setups. */
    transport?: MailTransport;
}

export interface Mailer {
    queue: (options: SendOptions) => Promise<{ queued: true }>;
    send: (options: SendOptions) => Promise<{ id: string }>;
}
