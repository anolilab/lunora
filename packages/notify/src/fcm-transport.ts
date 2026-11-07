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
    priority?: "normal" | "high";
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

const DEFAULT_ENDPOINT = "https://fcm.googleapis.com";

/**
 * Attempts a direct `sendTo` (topic or condition) makes: one plus three retries. The engine
 * provider makes one attempt per POST and leaves retries to the engine's own middleware, so an
 * engine-routed device send costs four POSTs, the same as web push.
 */
const MAX_ATTEMPTS = 4;

/** One POST per engine attempt. The engine's retry middleware owns the retries, so they are not doubled here. */
const ENGINE_ATTEMPTS = 1;

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

/**
 * Message text for a failed FCM request. The structured `UNREGISTERED` code (in
 * `error.details[].errorCode`) is the only dead-token signal: it is written as the
 * word itself, and no `HTTP 404` appears, so the subscription classifier in
 * `subscriptions/normalize` reads a dead token as gone and nothing else as gone.
 */
/** The body is untrusted: a retryable status can arrive with a differently shaped error, so the shape is checked, not assumed. */
const hasUnregisteredCode = (details: unknown): boolean =>
    Array.isArray(details) &&
    details.some((detail: unknown) => typeof detail === "object" && detail !== null && "errorCode" in detail && detail.errorCode === "UNREGISTERED");

const failureMessage = (status: number, body: unknown): string => {
    const error = (body as FcmErrorBody | null | undefined)?.error;
    const code = hasUnregisteredCode(error?.details) ? "UNREGISTERED" : (error?.status ?? "ERROR");

    return `FCM ${String(status)} ${code}: ${error?.message ?? "request failed"}`;
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

/**
 * The FCM v1 `message` for one target. `title`/`body`/`imageUrl`/`data` map to the
 * shared notification, `ttl`/`urgency`/`clickAction`/`sound`/`badge` to their
 * platform fields, and `fcmOverrides` is merged over the top so an app can always override
 * what the common fields produce. Empty blocks are left out of the wire body.
 */
const buildFcmMessage = (payload: FcmPayload, target: FcmTarget): Record<string, unknown> => {
    const overrides = payload.fcmOverrides;
    const hasNotification = nonEmpty(payload.title) || nonEmpty(payload.body) || nonEmpty(payload.imageUrl);
    const hasAndroid =
        payload.ttl !== undefined ||
        payload.urgency !== undefined ||
        payload.clickAction !== undefined ||
        payload.sound !== undefined ||
        overrides?.android !== undefined;
    const hasApns = payload.badge !== undefined || payload.sound !== undefined || overrides?.apns !== undefined;

    return {
        ...target,
        apns: hasApns
            ? {
                  ...overrides?.apns,
                  payload: {
                      ...overrides?.apns?.payload,
                      aps: { badge: payload.badge, sound: payload.sound, ...overrides?.apns?.payload?.aps },
                  },
              }
            : undefined,
        android: hasAndroid
            ? {
                  ...(payload.ttl === undefined ? {} : { ttl: `${String(payload.ttl)}s` }),
                  ...(payload.urgency === undefined ? {} : { priority: payload.urgency === "high" ? "high" : "normal" }),
                  ...overrides?.android,
                  notification: { click_action: payload.clickAction, sound: payload.sound, ...overrides?.android?.notification },
              }
            : undefined,
        data: toWireData(payload.data),
        fcm_options: overrides?.fcm_options,
        notification: hasNotification ? { body: payload.body, image: payload.imageUrl, title: payload.title } : undefined,
        webpush: overrides?.webpush,
    };
};

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/**
 * POST one message, retrying transport errors and 408/429/5xx with jittered
 * exponential backoff. Any other failure is final on the first response.
 */
const postMessage = async (
    config: FcmConfig,
    token: string,
    message: Record<string, unknown>,
    attempts: number,
    options: FcmTransportOptions,
): Promise<string> => {
    const fetchImpl = options.fetch ?? fetch;
    const url = `${config.endpoint ?? DEFAULT_ENDPOINT}/v1/projects/${config.projectId}/messages:send`;
    const body = JSON.stringify({ message });
    const baseDelay = options.retryBaseDelay ?? 250;
    let lastError: Error = new Error("FCM send failed");

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) {
            // eslint-disable-next-line no-await-in-loop -- retries are sequential by definition: each waits out the last
            await new Promise((resolve) => {
                // Jitter spreads retries out; it is not a security input.
                // eslint-disable-next-line sonarjs/pseudo-random -- retry jitter, not a secret
                setTimeout(resolve, baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelay));
            });
        }

        let response: Response;

        try {
            // eslint-disable-next-line no-await-in-loop -- one attempt at a time; a parallel retry would double-send
            response = await fetchImpl(url, {
                body,
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                method: "POST",
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- the body must be read before the next attempt is decided
        const text = await readCappedBody(response);

        if (response.ok) {
            // A 2xx without a message name is not a delivery we can account for, so it fails rather than reporting an empty id.
            const name = (parseBody(text) as { name?: unknown } | null | undefined)?.name;

            if (typeof name !== "string" || name === "") {
                throw new Error("FCM accepted the request but returned no message name");
            }

            return name;
        }

        lastError = new Error(failureMessage(response.status, parseBody(text)));

        if (!retryable(response.status)) {
            throw lastError;
        }
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
const createFcmTransport = (config: FcmConfig, options: FcmTransportOptions = {}): FcmTransport => {
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

    const sendAttempts = options.maxAttempts ?? MAX_ATTEMPTS;

    const sendTo: FcmTransport["sendTo"] = async (target, payload) => {
        assertFcmTarget(target);
        requireConfigured();

        return postMessage(config, await accessToken(), buildFcmMessage(payload, target), sendAttempts, options);
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
                    const messageId = await postMessage(config, token, buildFcmMessage(payload, { token: recipient }), ENGINE_ATTEMPTS, options);

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
