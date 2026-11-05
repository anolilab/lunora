import { assertValidIdempotencyKey } from "./address";
import { isOutcomeUnknownMailError, isRetryableMailError, MailSendError } from "./send-error";
import type { Mailer, SendOptions } from "./types";

/** Serializable representation of a `SendOptions` payload — drops the `react` field. */
interface QueuedSend {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;

    /**
     * Stable dedup key, minted at enqueue time by `createMailer(...).queue()` — see
     * `SendOptions.idempotencyKey`. `consumeQueuedSend` dedupes on it when given a
     * `sent` store, and forwards it to the provider.
     */
    idempotencyKey?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

/**
 * Narrow a `SendOptions` to its serializable `QueuedSend` shape by dropping the
 * non-cloneable `react` field. React elements are not structured-cloneable, so
 * the queue body must carry only the pre-rendered html/text and scalar fields.
 */
const toQueuedPayload = (options: SendOptions): QueuedSend => {
    const queued = { ...options };

    delete queued.react;

    return queued;
};

/**
 * Where {@link consumeQueuedSend} records the idempotency keys it has already
 * sent, mapped to the provider's message id. Shaped after Workers KV's
 * `get` / `put`, so a `KVNamespace` binding passes as-is; a Durable Object or
 * D1-backed adapter works too. Only a string from `get` counts as sent, so an
 * adapter may answer a missing key with `null` (KV) or `undefined` (Durable
 * Object storage).
 */
interface SentMailStore {
    get: (key: string) => Promise<string | null | undefined>;
    put: (key: string, value: string, options: { expirationTtl: number }) => Promise<void>;
}

interface ConsumeQueuedSendOptions {
    /**
     * Which delivery of the message this is: pass the Cloudflare Queues `message.attempts` (1 for the first). A
     * redelivery may follow an attempt that reached the provider, so one older than the provider's dedupe window
     * (`enqueuedAt`) is refused before any request; a first delivery is sent at any age, since nothing went out yet.
     */
    attempts?: number;

    /**
     * When the message was first enqueued: pass the Cloudflare Queues
     * `message.timestamp`. Resend drops a repeated key for only 24 hours, so an
     * outcome-unknown failure of a message older than 23 hours is not retryable,
     * because a redelivery could then mail a second copy. Without it, nothing
     * tracks that window.
     */
    enqueuedAt?: Date;

    /**
     * Collapse redeliveries: a message whose `idempotencyKey` is already in the
     * store is acknowledged without a second send, and a sent message's key is
     * recorded here. With a store, a body without an `idempotencyKey` is refused.
     * Passing the key with an `undefined` value (an unbound `env.SENT`) logs a
     * warning on every call, because dedupe is then off.
     */
    sent?: SentMailStore;

    /**
     * How long a sent key is remembered, in whole seconds, at least 60 (default
     * 86 400), the range Workers KV accepts. A redelivery later than this sends
     * again. Anything else fails every message as a retryable `MailSendError`.
     */
    sentTtlSeconds?: number;
}

const DEFAULT_SENT_TTL_SECONDS = 86_400;

/** How long a read of, or a write to, the sent-mail store may take before it is given up on. */
const SENT_STORE_TIMEOUT_MS = 10_000;

/** Resend keeps an idempotency key for 24 hours; the hour short of that covers the redelivery delay. */
const PROVIDER_DEDUPE_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Workers KV's floor for `expirationTtl`. */
const MIN_SENT_TTL_SECONDS = 60;

/** A queue body no redelivery can fix, refused before anything is read or sent. */
const malformed = (message: string): MailSendError => new MailSendError({ message: `@lunora/mail: ${message}`, retryable: false });

/**
 * Validate an untrusted queue body into `SendOptions`. Every throw here is a
 * malformed message, which no redelivery fixes, so none is retryable.
 */
const toSendOptions = (payload: unknown): SendOptions => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw malformed("queue message body must be an object");
    }

    const candidate = payload as Record<string, unknown>;

    // Shape-check the message body before handing it to the transport — the
    // queue is an untrusted boundary (workers can land arbitrary JSON) and a
    // malformed payload here would otherwise surface as an obscure provider
    // error downstream.
    if (typeof candidate.subject !== "string") {
        throw malformed("queue message must have a string `subject`");
    }

    const recipientIsString = typeof candidate.to === "string";
    const recipientIsStringArray = Array.isArray(candidate.to) && candidate.to.every((value) => typeof value === "string");

    if (!recipientIsString && !recipientIsStringArray) {
        throw malformed("queue message `to` must be a string or string[]");
    }

    const assertOptionalString = (field: string, value: unknown): string | undefined => {
        if (value === undefined) {
            return undefined;
        }

        if (typeof value !== "string") {
            throw malformed(`queue message \`${field}\` must be a string`);
        }

        return value;
    };

    const assertOptionalStringList = (field: string, value: unknown): string[] | undefined => {
        if (value === undefined) {
            return undefined;
        }

        // A lone string is accepted for convenience and normalized to a
        // single-element list — `bcc`/`cc` are `string[]` downstream and the
        // address parser treats `"a"` and `["a"]` identically, so wrapping is
        // behavior-preserving while keeping the return type uniform.
        if (typeof value === "string") {
            return [value];
        }

        if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
            return value;
        }

        throw malformed(`queue message \`${field}\` must be a string or string[]`);
    };

    let headers: Record<string, string> | undefined;

    if (candidate.headers !== undefined) {
        if (!candidate.headers || typeof candidate.headers !== "object" || Array.isArray(candidate.headers)) {
            throw malformed("queue message `headers` must be an object of string values");
        }

        const entries = Object.entries(candidate.headers as Record<string, unknown>);

        for (const [key, value] of entries) {
            if (typeof value !== "string") {
                throw malformed(`queue message header "${key}" must be a string`);
            }
        }

        headers = candidate.headers as Record<string, string>;
    }

    const idempotencyKey = assertOptionalString("idempotencyKey", candidate.idempotencyKey);

    assertValidIdempotencyKey(idempotencyKey);

    // Build a typed payload from the validated fields rather than blindly
    // casting the untrusted body — the cast would defeat the type system at
    // exactly the boundary this function exists to guard.
    const options: SendOptions = {
        bcc: assertOptionalStringList("bcc", candidate.bcc),
        cc: assertOptionalStringList("cc", candidate.cc),
        from: assertOptionalString("from", candidate.from),
        headers,
        html: assertOptionalString("html", candidate.html),
        idempotencyKey,
        replyTo: assertOptionalString("replyTo", candidate.replyTo),
        subject: candidate.subject,
        text: assertOptionalString("text", candidate.text),
        to: candidate.to as string | string[],
    };

    return options;
};

/**
 * Whether a message is past the provider's dedupe window. The age is measured from enqueue, which is never later than
 * the provider's first sight of the key, so the check errs toward acking; an invalid date counts as too old too.
 */
const pastDedupeWindow = (enqueuedAt: Date | undefined): boolean => {
    const ageMs = enqueuedAt === undefined ? 0 : Date.now() - enqueuedAt.getTime();

    return Number.isNaN(ageMs) || ageMs >= PROVIDER_DEDUPE_WINDOW_MS;
};

/**
 * Send, and never send a repeat the provider can no longer drop: a redelivery past the window is refused before any
 * request (an earlier attempt may have landed), and a failed send that may have landed is not retried past it.
 */
const sendInsideDedupeWindow = async (
    mailer: Mailer,
    sendOptions: SendOptions,
    enqueuedAt: Date | undefined,
    attempts: number | undefined,
): Promise<{ id: string }> => {
    if (attempts !== undefined && attempts > 1 && pastDedupeWindow(enqueuedAt)) {
        throw new MailSendError({
            message: "@lunora/mail: an earlier delivery of this message may have been sent, and the provider no longer dedupes a key this old",
            outcomeUnknown: true,
            retryable: false,
        });
    }

    try {
        return await mailer.send(sendOptions);
    } catch (error) {
        if (isOutcomeUnknownMailError(error) && isRetryableMailError(error) && pastDedupeWindow(enqueuedAt)) {
            throw new MailSendError({
                cause: error,
                message: "@lunora/mail: the send may have been delivered, and the provider no longer dedupes a key this old",
                outcomeUnknown: true,
                retryable: false,
            });
        }

        throw error;
    }
};

/** `work`, or a rejection once the sent-mail store has not answered within {@link SENT_STORE_TIMEOUT_MS}. */
const withinStoreDeadline = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`the sent-mail store did not answer within ${String(SENT_STORE_TIMEOUT_MS)}ms`));
                }, SENT_STORE_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/** A Workers Logs line: JSON, so the event and its fields can be filtered on. */
const logEvent = (level: "error" | "warn", event: string, message: string, error?: unknown): void => {
    const line = JSON.stringify({
        event,
        message,
        ...(error !== undefined && {
            error:
                error instanceof Error
                    ? { message: error.message, name: error.name, stack: error.stack }
                    : { message: typeof error === "string" ? error : typeof error },
        }),
    });

    // eslint-disable-next-line no-console -- the package has no logger; Workers Logs reads the console
    console[level](line);
};

/**
 * Record a sent key, bounded: a stalled store would hold the message unacked
 * until it is redelivered and, without the record, sent again. A failure here is
 * logged rather than thrown, because the provider already accepted the send.
 */
const recordSent = async (sent: SentMailStore, key: string, id: string, expirationTtl: number): Promise<void> => {
    try {
        await withinStoreDeadline(sent.put(key, id, { expirationTtl }));
    } catch (error) {
        // The send succeeded; failing it now would redeliver a message the provider accepted.
        logEvent("error", "lunora.mail.sent_record_failed", "@lunora/mail: sent, but could not record the idempotency key; a redelivery may send again", error);
    }
};

/**
 * Helper used by Queue consumers: validate a `QueuedSend` body and send it
 * through `mailer.send()`. Use it inside your Worker's `queue()` handler, and
 * `ack()` each message it settles.
 *
 * Pass `sent` (a KV namespace, or anything shaped like one) to collapse
 * Cloudflare Queues' at-least-once redelivery: a key already in the store
 * returns its recorded id with `deduplicated: true` and sends nothing, and a
 * successful send records its key. Only a success is recorded, so a retryable
 * or outcome-unknown failure never blocks a later attempt. A store that cannot
 * be read, or does not answer within 10 seconds, fails the send as retryable,
 * since nothing has gone out; a store that cannot be written after the send, or
 * does not answer within 10 seconds, is logged and the id still returned, because throwing then would redeliver a
 * message the provider already accepted.
 *
 * This NARROWS the duplicate window; it does not close it, and nothing on this
 * path can. The mark is written after the provider accepted the message, so a
 * crash in between still redelivers and resends, and a KV read is eventually
 * consistent — a redelivery seconds later can miss a mark that was written.
 * Delivery is at-least-once end to end. An app that must not double-send needs a
 * strongly-consistent mark taken BEFORE the send (a Durable Object or D1 row
 * claimed by this key, released on failure), and even then the send-then-crash
 * window is only ever traded for a send-that-may-not-have-happened one. With
 * Resend the key also travels as the `Idempotency-Key` request header, so Resend
 * itself drops a repeat inside its own 24-hour window; pass `enqueuedAt` and
 * `attempts` so a send that may have landed is not repeated once that window is
 * nearly over.
 *
 * ```ts
 * export default {
 *   queue: async (batch, env) => {
 *     // createMailerFromEnv, so dev captures the message here instead of sending it.
 *     const mailer = createMailerFromEnv(env);
 *     for (const message of batch.messages) {
 *       try {
 *         await consumeQueuedSend(mailer, message.body, { attempts: message.attempts, enqueuedAt: message.timestamp, sent: env.SENT });
 *       } catch (error) {
 *         // Transient, or a send that may have landed with a provider that dedupes on the key (Resend).
 *         if (isRetryableMailError(error)) {
 *           // The first attempt may still be running at the provider (Resend's client keeps a request
 *           // going for about two minutes), so give it time: a repeat inside that window is a 409.
 *           message.retry(isOutcomeUnknownMailError(error) ? { delaySeconds: 180 } : undefined);
 *           continue;
 *         }
 *
 *         // A timeout no provider dedupes may have been delivered, so a retry could send a second
 *         // copy: check the provider's logs. Anything else is a refusal or a malformed body.
 *         console.error(isOutcomeUnknownMailError(error) ? "mail outcome unknown" : "mail refused", error);
 *         message.ack();
 *         continue;
 *       }
 *       // Per message: without it a single throw retries the whole batch.
 *       message.ack();
 *     }
 *   },
 * };
 * ```
 */
const consumeQueuedSend = async (mailer: Mailer, payload: unknown, options: ConsumeQueuedSendOptions = {}): Promise<{ deduplicated: boolean; id: string }> => {
    const { attempts, enqueuedAt, sent, sentTtlSeconds = DEFAULT_SENT_TTL_SECONDS } = options;

    // Every put would throw and be swallowed below, turning dedupe off without a word. It is the
    // deploy's fault, not the message's, so it is retryable: an ack would drop every queued mail.
    if (!Number.isSafeInteger(sentTtlSeconds) || sentTtlSeconds < MIN_SENT_TTL_SECONDS) {
        throw new MailSendError({
            message: `@lunora/mail: \`sentTtlSeconds\` must be a whole number of seconds, at least ${String(MIN_SENT_TTL_SECONDS)}`,
            retryable: true,
        });
    }

    const sendOptions = toSendOptions(payload);

    if (!sent) {
        if ("sent" in options) {
            // An unbound KV namespace arrives as `undefined`; the caller meant to dedupe.
            logEvent(
                "warn",
                "lunora.mail.sent_store_unbound",
                "@lunora/mail: consumeQueuedSend got `sent: undefined` (is the KV namespace bound?), so redeliveries are not deduplicated",
            );
        }

        return { deduplicated: false, ...(await sendInsideDedupeWindow(mailer, sendOptions, enqueuedAt, attempts)) };
    }

    const key = sendOptions.idempotencyKey;

    if (key === undefined) {
        throw malformed("queue message has no `idempotencyKey` to dedupe on");
    }

    let recorded: string | null | undefined;

    try {
        recorded = await withinStoreDeadline(sent.get(key));
    } catch (error) {
        // Nothing has been sent yet, so a redelivery is safe and an ack would drop the mail. A read that never
        // settles fails the same way, rather than holding the invocation.
        throw new MailSendError({ cause: error, message: "@lunora/mail: could not read the sent-mail store", retryable: true });
    }

    // Only a recorded id counts as a hit: an adapter over Durable Object storage resolves `undefined`
    // for a missing key, and treating that as sent would ack every message unsent.
    if (typeof recorded === "string") {
        return { deduplicated: true, id: recorded };
    }

    const { id } = await sendInsideDedupeWindow(mailer, sendOptions, enqueuedAt, attempts);

    await recordSent(sent, key, id, sentTtlSeconds);

    return { deduplicated: false, id };
};

export { consumeQueuedSend, toQueuedPayload };
export type { ConsumeQueuedSendOptions, QueuedSend, SentMailStore };
