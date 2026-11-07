import { LunoraError } from "@lunora/errors";
import type { NotificationResult, Provider, PushPayload, RecipientResult, Result } from "@visulima/notification";
import type { FcmConfig } from "@visulima/notification/providers/fcm";

/**
 * The per-platform blocks of an FCM HTTP v1 message, forwarded as sent. Only the
 * fields a push app reaches for are typed; a field not listed here is a type error
 * rather than being silently dropped, so a typo cannot reach the wire unnoticed.
 */
interface FcmAndroidConfig {
    collapse_key?: string;
    data?: Record<string, string>;
    fcm_options?: { analytics_label?: string };
    notification?: {
        body?: string;
        channel_id?: string;
        click_action?: string;
        color?: string;
        icon?: string;
        image?: string;
        sound?: string;
        tag?: string;
        title?: string;
    };
    /** FCM HTTP v1 takes the uppercase enum values. */
    priority?: "HIGH" | "NORMAL";
    ttl?: string;
}

interface FcmApnsConfig {
    fcm_options?: { analytics_label?: string; image?: string };
    headers?: Record<string, string>;
    payload?: {
        [key: string]: unknown;
        aps?: {
            alert?: { body?: string; subtitle?: string; title?: string };
            badge?: number;
            category?: string;
            "content-available"?: 0 | 1;
            "interruption-level"?: "passive" | "active" | "time-sensitive" | "critical";
            "mutable-content"?: 0 | 1;
            sound?: string | { critical?: 0 | 1; name?: string; volume?: number };
            "thread-id"?: string;
        };
    };
}

interface FcmWebpushConfig {
    data?: Record<string, string>;
    fcm_options?: { analytics_label?: string; link?: string };
    headers?: Record<string, string>;
    notification?: {
        actions?: ReadonlyArray<{ action: string; icon?: string; title: string }>;
        badge?: string;
        body?: string;
        dir?: "auto" | "ltr" | "rtl";
        icon?: string;
        image?: string;
        lang?: string;
        renotify?: boolean;
        requireInteraction?: boolean;
        silent?: boolean;
        tag?: string;
        title?: string;
        vibrate?: number[];
    };
}

/** Per-platform overrides for a push send. `ctx.push.*` takes them as `fcmOverrides`. */
interface FcmPlatformConfig {
    android?: FcmAndroidConfig;
    apns?: FcmApnsConfig;
    fcm_options?: { analytics_label?: string };
    webpush?: FcmWebpushConfig;
}

/** A push payload as the FCM transport reads it: the content plus optional per-platform overrides. */
type FcmPayload = Omit<PushPayload, "to"> & { fcmOverrides?: FcmPlatformConfig };

/** A message addressed to a device token, a topic, or a condition expression. */
type FcmTarget = { condition: string } | { token: string } | { topic: string };

interface FcmTransport {
    /** The engine-facing provider: delivers to each token in `to`. Topic and condition go through {@link FcmTransport.sendTo}. */
    provider: Provider<unknown, FcmPayload & { to: string | string[] }>;
    /** Send one message to a topic or condition. Resolves to the FCM message name. */
    sendTo: (target: Exclude<FcmTarget, { token: string }>, payload: FcmPayload) => Promise<string>;
}

interface FcmTransportOptions {
    /** Injected for tests; defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /** Attempts for a direct `sendTo`, including the first. Defaults to four. */
    maxAttempts?: number;
    /** Base of the exponential retry backoff, in ms. Only a test double changes it. */
    retryBaseDelay?: number;
}

/** The visulima FCM config plus the request knobs this transport honours when they are set. */
type FcmTransportConfig = FcmConfig & {
    /** Retries for a direct topic or condition send, after the first attempt. The engine's device path does not use it. */
    retries?: number;
    /** Per-request timeout in milliseconds. */
    timeout?: number;
};

/** Drops trailing slashes without a backtracking regex: a long run of them is linear here. */
const withoutTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value.charAt(end - 1) === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

const DEFAULT_ENDPOINT = "https://fcm.googleapis.com";

/**
 * Attempts a direct `sendTo` (topic or condition) makes: one plus three retries. The engine
 * provider makes one attempt per POST and leaves retries to the engine's own middleware, so an
 * engine-routed device send costs four POSTs, the same as web push.
 */
const MAX_ATTEMPTS = 4;

/** One POST per engine attempt. The engine's retry middleware owns the retries, so they are not doubled here. */
const ENGINE_ATTEMPTS = 1;

/** The longest delay between two attempts, before any `Retry-After`. Keeps a large retry count from overflowing a timer. */
const MAX_BACKOFF_MS = 30_000;

/** A success body is a short JSON object. Anything larger is refused rather than buffered. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Per request, so one stalled connection cannot hold a send open indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000;

/** FCM's documented topic name format. Anything else is rejected before a request is made. */
const TOPIC_PATTERN = /^[\w.~%-]+$/u;

interface FcmErrorBody {
    error?: {
        details?: ReadonlyArray<{ errorCode?: string }>;
        message?: string;
        status?: string;
    };
}

/** The `errorCode` of one detail entry, read without trusting its shape. */
const detailErrorCode = (detail: unknown): string | undefined => {
    if (typeof detail !== "object" || detail === null || !("errorCode" in detail)) {
        return undefined;
    }

    const code: unknown = detail.errorCode;

    return typeof code === "string" ? code : undefined;
};

const UPPER_CASE_CODE = /^[A-Z_]+$/u;

/** The first structured `errorCode` in the details, when there is one and it is a plain upper-case token. */
const firstDetailCode = (details: unknown): string | undefined => {
    if (!Array.isArray(details)) {
        return undefined;
    }

    for (const detail of details as ReadonlyArray<unknown>) {
        const code = detailErrorCode(detail);

        if (code !== undefined && UPPER_CASE_CODE.test(code)) {
            return code;
        }
    }

    return undefined;
};

/** The body is untrusted: a retryable status can arrive with a differently shaped error, so the shape is checked, not assumed. */
const hasUnregisteredCode = (details: unknown): boolean =>
    Array.isArray(details) &&
    details.some((detail: unknown) => typeof detail === "object" && detail !== null && "errorCode" in detail && detail.errorCode === "UNREGISTERED");

/**
 * Message text for a failed FCM request. The structured `UNREGISTERED` code (in
 * `error.details[].errorCode`) is the only dead-token signal: it is written as the
 * word itself, and no `HTTP 404` appears, so the subscription classifier in
 * `subscriptions/normalize` reads a dead token as gone and nothing else as gone.
 */
const failureMessage = (httpStatus: number, body: unknown): string => {
    const error = (body as FcmErrorBody | null | undefined)?.error;
    // The body is untrusted: a field of the wrong type is ignored rather than rendered as "[object Object]".
    const message = typeof error?.message === "string" ? error.message : "request failed";
    const status = typeof error?.status === "string" ? error.status : undefined;
    // The status is a fallback name only: a body whose status reads UNREGISTERED but whose details do not is not a dead-token report.
    const fallback = status !== undefined && status !== "UNREGISTERED" ? status : "ERROR";
    // A structured code from the details names the refusal (SENDER_ID_MISMATCH, for one) more precisely than the HTTP status.
    const detailed = firstDetailCode(error?.details);
    const code = hasUnregisteredCode(error?.details) ? "UNREGISTERED" : (detailed ?? fallback);

    return `FCM ${String(httpStatus)} ${code}: ${message}`;
};

/** Read a response body up to {@link MAX_RESPONSE_BYTES}, cancelling the stream once it is exceeded. */
const readCappedBody = async (response: Response): Promise<string> => {
    const reader = response.body?.getReader();

    if (reader === undefined) {
        return "";
    }

    const chunks: Uint8Array[] = [];
    let size = 0;

    let next = await reader.read();

    while (!next.done) {
        size += next.value.byteLength;

        if (size > MAX_RESPONSE_BYTES) {
            // eslint-disable-next-line no-await-in-loop -- the cancel must settle before the error is thrown
            await reader.cancel();

            throw new Error(`FCM response is larger than ${String(MAX_RESPONSE_BYTES)} bytes`);
        }

        chunks.push(next.value);
        // eslint-disable-next-line no-await-in-loop -- see above
        next = await reader.read();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(bytes);
};

const parseBody = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const nonEmpty = (value: string | undefined): boolean => value !== undefined && value !== "";

const toWireData = (data: Record<string, unknown> | undefined): Record<string, string> | undefined =>
    data === undefined
        ? undefined
        : Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));

/** FCM HTTP v1 takes the uppercase enum values; lowercase is rejected. */
const androidPriorityOf = (urgency: string): "HIGH" | "NORMAL" => (urgency === "high" ? "HIGH" : "NORMAL");

// APNs delivers immediately when the header is absent, so `normal` (the default) sets nothing: only `high` raises
// the priority and the low urgencies lower it.
const apnsPriorityOf = (urgency: string): "10" | "5" | undefined => {
    if (urgency === "high") {
        return "10";
    }

    return urgency === "low" || urgency === "very-low" ? "5" : undefined;
};

/** An object with no defined value is left out of the wire body entirely. */
const definedOnly = <T extends Record<string, unknown>>(value: T): T | undefined =>
    Object.values(value).some((entry) => entry !== undefined) ? value : undefined;

/**
 * The FCM v1 `message` for one target. `title`/`body`/`imageUrl`/`data` map to the
 * shared notification. `ttl` and `urgency` map to every platform's expiry and priority
 * (Android `ttl`/`priority`, APNs `apns-expiration`/`apns-priority`, Web Push `TTL`/`Urgency`),
 * and `clickAction`/`sound`/`badge` to their Android and APNs slots. `fcmOverrides` is
 * merged over all of it, so an app can always override what the common fields produce.
 * A block with nothing in it is left out, so a data-only send carries no notification.
 */
const buildFcmMessage = (payload: FcmPayload, target: FcmTarget): Record<string, unknown> => {
    const overrides = payload.fcmOverrides;
    const hasNotification = nonEmpty(payload.title) || nonEmpty(payload.body) || nonEmpty(payload.imageUrl);
    const ttlSeconds = payload.ttl === undefined ? undefined : String(payload.ttl);
    const expiresAt = payload.ttl === undefined ? undefined : String(Math.floor(Date.now() / 1000) + payload.ttl);
    const androidPriority = payload.urgency === undefined ? undefined : androidPriorityOf(payload.urgency);
    const apnsPriority = payload.urgency === undefined ? undefined : apnsPriorityOf(payload.urgency);

    const androidNotification = definedOnly({ click_action: payload.clickAction, sound: payload.sound, ...overrides?.android?.notification });
    const android = definedOnly({
        ttl: payload.ttl === undefined ? undefined : `${String(payload.ttl)}s`,
        priority: androidPriority,
        ...overrides?.android,
        notification: androidNotification,
    });

    const aps = definedOnly({ badge: payload.badge, sound: payload.sound, ...overrides?.apns?.payload?.aps });
    const apns = definedOnly({
        ...overrides?.apns,
        headers: definedOnly({ "apns-expiration": expiresAt, "apns-priority": apnsPriority, ...overrides?.apns?.headers }),
        payload: definedOnly({ ...overrides?.apns?.payload, aps }),
    });

    const webpush = definedOnly({
        ...overrides?.webpush,
        headers: definedOnly({ TTL: ttlSeconds, Urgency: payload.urgency, ...overrides?.webpush?.headers }),
    });

    return {
        ...target,
        android,
        apns,
        data: toWireData(payload.data),
        fcm_options: overrides?.fcm_options,
        notification: hasNotification ? { body: payload.body, image: payload.imageUrl, title: payload.title } : undefined,
        webpush,
    };
};

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** Longest `Retry-After` the transport will wait out. A longer one fails the send rather than hold a Worker. */
const MAX_RETRY_AFTER_MS = 10_000;

/** `Retry-After` is either delay-seconds or an HTTP date. Returns milliseconds to wait, or undefined when absent or unreadable. */
const parseRetryAfter = (value: string | null): number | undefined => {
    if (value === null || value.trim() === "") {
        return undefined;
    }

    const seconds = Number(value);

    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const date = Date.parse(value);

    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

/** A whole attempt count from a configured value. A non-finite value falls back to the default. */
const attemptCount = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Outcome of one POST: done, worth another attempt, or final. */
type Attempt = { kind: "done"; messageName: string } | { error: Error; kind: "final" } | { error: Error; kind: "retry"; retryAfterMs?: number };

/**
 * Whether a status may be retried. A fan-out send (a topic or condition) reaches every subscriber,
 * and FCM may already have accepted a 5xx or a timed-out POST, so only 429 (refused) is retried.
 * A device send is one recipient, and the engine's retry has always covered 408/429/5xx.
 */
const mayRetry = (status: number, fanOut: boolean): boolean => (fanOut ? status === 429 : retryable(status));

/** Read a response and classify it. A retryable status is retried even when its body is unreadable; the status decides. */

/**
 * The verdict on a refused response. Whether its body could be read changes the message, never the rule: a
 * status that may be retried is retried for the `Retry-After` it asked, unless that is longer than we will hold a
 * send open. That case is final, and its message says so, so the engine's policy (which sees only the message) agrees.
 */
const refusalVerdict = (error: Error, status: number, fanOut: boolean, retryAfterMs: number | undefined): Attempt => {
    if (!mayRetry(status, fanOut)) {
        return { error, kind: "final" };
    }

    if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
        return { error: new Error(`${error.message} (Retry-After exceeds the ${String(MAX_RETRY_AFTER_MS / 1000)}s wait limit)`), kind: "final" };
    }

    return { error, kind: "retry", retryAfterMs };
};

/** Read a response and classify it. The status decides retry; an unreadable body changes only the message. */
const classify = async (response: Response, fanOut: boolean): Promise<Attempt> => {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    let text: string;

    try {
        text = await readCappedBody(response);
    } catch (error) {
        const readError = toError(error);

        if (response.ok) {
            // A 2xx we cannot read is probably an acceptance FCM already made: final, and marked so the engine does not re-send it.
            return { error: new Error(`FCM ${String(response.status)} ACCEPTED_UNREADABLE: ${readError.message}`), kind: "final" };
        }

        // The status stays in the message: the engine's policy classifies on text, and an oversized 400 or 404 must stay final.
        return refusalVerdict(new Error(`FCM ${String(response.status)} ERROR: ${readError.message}`), response.status, fanOut, retryAfterMs);
    }

    if (response.ok) {
        // A 2xx without a message name is probably an acceptance FCM already made: final, and marked so the engine does not re-send it.
        const name = (parseBody(text) as { name?: unknown } | null | undefined)?.name;

        return typeof name === "string" && name !== ""
            ? { kind: "done", messageName: name }
            : { error: new Error("FCM 200 ACCEPTED_NO_NAME: the request was accepted but returned no message name"), kind: "final" };
    }

    return refusalVerdict(new Error(failureMessage(response.status, parseBody(text))), response.status, fanOut, retryAfterMs);
};

/**
 * One POST. A transport error is a retry for a device send, but final for a fan-out send: a timeout
 * can follow an acceptance FCM already made, and a retry would reach the whole audience again.
 */
const sendOnce = async (url: string, body: string, token: string, timeoutMs: number, fetchImpl: typeof fetch, fanOut: boolean): Promise<Attempt> => {
    try {
        const response = await fetchImpl(url, {
            body,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
        });

        return await classify(response, fanOut);
    } catch (error) {
        return { error: toError(error), kind: fanOut ? "final" : "retry" };
    }
};

/**
 * POST one message, retrying transport errors and 408/429/5xx with jittered exponential
 * backoff, raised to any `Retry-After` the service sends. Anything else is final on the
 * first response.
 */
const postMessage = async (
    config: FcmTransportConfig,
    token: string,
    message: Record<string, unknown>,
    attempts: number,
    options: FcmTransportOptions,
    fanOut: boolean,
): Promise<string> => {
    // A trailing slash on the configured endpoint would produce `//v1/...`, which some gateways route differently.
    const base = withoutTrailingSlashes(config.endpoint ?? DEFAULT_ENDPOINT);
    const url = `${base}/v1/projects/${config.projectId}/messages:send`;
    const body = JSON.stringify({ message });
    const baseDelay = options.retryBaseDelay ?? 250;
    const timeoutMs = config.timeout ?? REQUEST_TIMEOUT_MS;
    let lastError: Error = new Error("FCM send failed");
    let retryAfterMs: number | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) {
            // Jitter spreads retries out; it is not a security input.
            // eslint-disable-next-line sonarjs/pseudo-random -- retry jitter, not a secret
            const jitterMs = Math.floor(Math.random() * baseDelay);
            // Capped: a large retry count would otherwise grow past what a timer can hold, and then fire almost at once.
            const backoffMs = Math.min(baseDelay * 2 ** (attempt - 1) + jitterMs, MAX_BACKOFF_MS);

            // eslint-disable-next-line no-await-in-loop -- retries are sequential by definition: each waits out the last
            await new Promise((resolve) => {
                setTimeout(resolve, Math.max(backoffMs, retryAfterMs ?? 0));
            });
        }

        // eslint-disable-next-line no-await-in-loop -- one attempt at a time; a parallel retry would double-send
        const outcome = await sendOnce(url, body, token, timeoutMs, options.fetch ?? fetch, fanOut);

        if (outcome.kind === "done") {
            return outcome.messageName;
        }

        lastError = outcome.error;

        if (outcome.kind === "final") {
            throw lastError;
        }

        retryAfterMs = outcome.retryAfterMs;
    }

    // The last attempt was refused with a Retry-After. The caller's own retry (the engine's, for a device send) starts
    // on its short backoff, so the requested interval is waited out here, before the failure is reported.
    if (!fanOut && retryAfterMs !== undefined && retryAfterMs > 0) {
        await new Promise((resolve) => {
            setTimeout(resolve, retryAfterMs);
        });
    }

    throw lastError;
};

/**
 * Reject a topic or condition the FCM API would refuse, before any request. A bad
 * target is the caller's input error, so it is a `BAD_REQUEST`, not a send failure.
 */
const assertFcmTarget = (target: FcmTarget): void => {
    if ("topic" in target && !TOPIC_PATTERN.test(target.topic)) {
        throw new LunoraError("BAD_REQUEST", `@lunora/notify: FCM topic ${JSON.stringify(target.topic)} must match ${String(TOPIC_PATTERN)}`);
    }

    if ("condition" in target && target.condition.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "@lunora/notify: FCM condition must be a non-empty expression");
    }
};

/**
 * An edge-safe FCM HTTP v1 transport. It replaces `@visulima/notification`'s FCM
 * provider, which builds the message from title/body/data only and keeps just the
 * error text of a failed request. This one forwards the per-platform overrides and
 * the structured error code, so a dead token is recognised by `UNREGISTERED` alone.
 */
const createFcmTransport = (config: FcmTransportConfig, options: FcmTransportOptions = {}): FcmTransport => {
    // Checked at send time, not at construction: a throw from the engine's provider would take every channel down with it.
    const requireConfigured = (): void => {
        if (!config.projectId) {
            throw new Error("FCM projectId is not configured");
        }
    };

    const accessToken = async (): Promise<string> => {
        if (config.getAccessToken !== undefined) {
            return config.getAccessToken();
        }

        if (config.accessToken !== undefined && config.accessToken !== "") {
            return config.accessToken;
        }

        throw new Error("FCM has no access token: set FCM_SERVICE_ACCOUNT, or pass getAccessToken to the fcm channel");
    };

    // `retries` is the FcmConfig's own knob: it sets how many attempts a direct topic or condition send makes.
    // The engine's device path stays one POST per attempt, so its retries are not governed by this field.
    // A non-finite or fractional count would make the loop run zero times or unevenly, so it is clamped to a whole number of attempts.
    const sendAttempts = attemptCount(options.maxAttempts ?? (config.retries === undefined ? undefined : config.retries + 1), MAX_ATTEMPTS);

    const sendTo: FcmTransport["sendTo"] = async (target, payload) => {
        assertFcmTarget(target);
        requireConfigured();

        return postMessage(config, await accessToken(), buildFcmMessage(payload, target), sendAttempts, options, true);
    };

    const provider: Provider<unknown, FcmPayload & { to: string | string[] }> = {
        channel: "push",
        endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
        features: { batchSending: false, media: true, richContent: true },
        id: "fcm",
        initialize: () => {},
        isAvailable: () => Boolean(config.projectId && (config.accessToken ?? config.getAccessToken)),
        options: config,
        send: async (payload): Promise<Result<NotificationResult>> => {
            // Same rule the previous provider applied: a bad TTL fails the send before a credential or a request is used.
            if (payload.ttl !== undefined && (!Number.isInteger(payload.ttl) || payload.ttl < 0)) {
                return { error: new Error(`push ttl must be a non-negative integer, got ${String(payload.ttl)}`), success: false };
            }

            try {
                requireConfigured();
            } catch (error) {
                return { error: new Error(messageOf(error)), success: false };
            }

            let token: string;

            try {
                token = await accessToken();
            } catch (error) {
                return { error: new Error(`FCM access token unavailable: ${messageOf(error)}`), success: false };
            }

            const targets = Array.isArray(payload.to) ? payload.to : [payload.to];
            const recipients: RecipientResult[] = [];

            for (const recipient of targets) {
                try {
                    // eslint-disable-next-line no-await-in-loop -- one message per recipient, in order, matching the engine's per-target receipts
                    const messageId = await postMessage(config, token, buildFcmMessage(payload, { token: recipient }), ENGINE_ATTEMPTS, options, false);

                    recipients.push({ id: recipient, messageId, status: "sent" });
                } catch (error) {
                    recipients.push({ error: messageOf(error), id: recipient, status: "failed" });
                }
            }

            const sent = recipients.find((recipient) => recipient.status === "sent");

            if (sent === undefined) {
                return { error: new Error(recipients[0]?.error ?? "All recipients failed"), success: false };
            }

            return {
                data: { channel: "push", messageId: sent.messageId ?? "", provider: "fcm", recipients, sent: true, timestamp: new Date() },
                success: true,
            };
        },
    };

    return { provider, sendTo };
};

export type { FcmAndroidConfig, FcmApnsConfig, FcmPayload, FcmPlatformConfig, FcmTarget, FcmTransport, FcmTransportOptions, FcmWebpushConfig };
export { assertFcmTarget, buildFcmMessage, createFcmTransport };
