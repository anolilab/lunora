/**
 * Shared plumbing for the `@visulima/email`-backed transports (Resend +
 * Cloudflare Email Workers). Both providers expose the same
 * `{ initialize, sendEmail }` shape and the same result envelope, so the
 * recipient guard, the provider-email mapping, and — critically — the
 * failure/redaction policy live here once instead of being copy-pasted (and
 * drifting) per provider. Each transport supplies only its provider instance
 * and its recipient policy.
 */
import { toAddress, toAddressList } from "./address";
import { MailSendError } from "./send-error";
import type { SendPayload } from "./types";

/** `@visulima/email` models an address as `{ email, name? }`. */
type ProviderAddress = { email: string; name?: string };

/** The provider-email payload both providers' `sendEmail` accept. */
interface ProviderEmail {
    bcc?: ProviderAddress[];
    cc?: ProviderAddress[];
    from: ProviderAddress;
    headers?: Record<string, string>;
    html?: string;
    replyTo?: ProviderAddress;
    subject: string;
    text?: string;
    to: ProviderAddress | ProviderAddress[];
}

/** A `@visulima/email` send result, narrowed to the fields the transports read. */
interface ProviderSendResult {
    data?: { messageId: string } | null;
    error?: unknown;
    success: boolean;
}

/**
 * Coerce an arbitrary provider error to a log-safe reason string. Kept verbose
 * (Error / null / string / number / object) so the server-side log is useful
 * regardless of what shape the provider rejected with.
 */
const reasonOf = (rawError: unknown): string => {
    if (rawError instanceof Error) {
        return rawError.message;
    }

    if (rawError === null || rawError === undefined) {
        return "send failed";
    }

    if (typeof rawError === "string") {
        return rawError;
    }

    if (typeof rawError === "number" || typeof rawError === "boolean" || typeof rawError === "bigint") {
        return rawError.toString();
    }

    // object | symbol | function — stringify defensively. JSON.stringify returns
    // undefined for symbol/function inputs (the lib types say string), so the
    // fallback is a real runtime branch.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify can return undefined for symbol/function despite its string type
    return JSON.stringify(rawError) ?? "send failed";
};

/** A provider error code that is an HTTP status, as `@visulima/email` writes it (`"429"`). */
const THREE_DIGIT_STATUS = /^\d{3}$/;

/** The HTTP status a provider error's `code` carries, as a number: the number itself, or a three-digit string. */
const httpStatusOf = (code: unknown): number | undefined => {
    if (typeof code === "number") {
        return code;
    }

    return typeof code === "string" && THREE_DIGIT_STATUS.test(code) ? Number(code) : undefined;
};

/**
 * Whether a provider's failed send is worth repeating. `@visulima/email` puts an
 * HTTP status on the error as a numeric `code`, so 408, 429 and 5xx are
 * transient and any other status is a refusal. A validation refusal has neither
 * a status nor a `cause`. A network or timeout failure has a `cause`, or the
 * `ETIMEDOUT` code. Anything the provider did not classify is retried, because a
 * wrong retry dead-letters the message and a wrong drop loses it.
 */
const isRetryableProviderError = (rawError: unknown): boolean => {
    if (!(rawError instanceof Error)) {
        return true;
    }

    // `@visulima/email` wraps a callback's failure as a `cause`, so the status can sit one or more levels down.
    let code: unknown;

    for (let current: unknown = rawError, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth += 1) {
        const candidate = "code" in current ? current.code : undefined;

        if (httpStatusOf(candidate) !== undefined) {
            code = candidate;
            break;
        }

        code ??= candidate;
    }

    const status = httpStatusOf(code);

    if (status !== undefined && status >= 100 && status <= 599) {
        return status === 408 || status === 429 || status >= 500;
    }

    return !(code === undefined && rawError.cause === undefined);
};

/** Resolve the validated recipient list + its first entry, throwing when empty. */
const requireRecipients = (to: SendPayload["to"]): { first: ProviderAddress; list: ProviderAddress[] } => {
    const list = toAddressList(to);
    const [first] = list ?? [];

    if (!list || first === undefined) {
        throw new MailSendError({ message: "@lunora/mail: at least one recipient is required", retryable: false });
    }

    return { first, list };
};

/** Map a rendered {@link SendPayload} onto the provider-email shape, with the resolved `to`. */
const toProviderEmail = (payload: SendPayload, defaultFrom: string, to: ProviderAddress | ProviderAddress[]): ProviderEmail => {
    return {
        bcc: toAddressList(payload.bcc),
        cc: toAddressList(payload.cc),
        from: toAddress(payload.from ?? defaultFrom),
        headers: payload.headers,
        html: payload.html,
        replyTo: payload.replyTo ? toAddress(payload.replyTo) : undefined,
        subject: payload.subject,
        text: payload.text,
        to,
    };
};

/**
 * Interpret a provider send result: on failure, log the redacted reason
 * (server-side only — surfacing it to callers can disclose provider internals)
 * and throw a stable, generic error; on success, return the message id.
 */
const interpretSendResult = (result: ProviderSendResult): { id: string } => {
    if (result.success && !result.data) {
        // The provider accepted the send, so a redelivery would email the recipient twice.
        throw new MailSendError({ message: "@lunora/mail: provider accepted the send but returned no message id", retryable: false });
    }

    if (!result.success || !result.data) {
        // eslint-disable-next-line no-console -- intentional server-side log of the redacted provider error before throwing a generic message
        console.error(`@lunora/mail: send failed: ${reasonOf(result.error)}`);

        throw new MailSendError({ cause: result.error, retryable: isRetryableProviderError(result.error) });
    }

    return { id: result.data.messageId };
};

export { interpretSendResult, isRetryableProviderError, requireRecipients, toProviderEmail };
export type { ProviderSendResult };
