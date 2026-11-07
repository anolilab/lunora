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
    /** Base of the exponential retry backoff, in ms. Only a test double changes it. */
    retryBaseDelay?: number;
}

const DEFAULT_ENDPOINT = "https://fcm.googleapis.com";

/** One attempt plus three retries, the same budget the engine's own retry middleware spends. */
const MAX_ATTEMPTS = 4;

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
const failureMessage = (status: number, body: unknown): string => {
    const error = (body as FcmErrorBody | null | undefined)?.error;
    const code = error?.details?.some((detail) => detail.errorCode === "UNREGISTERED") ? "UNREGISTERED" : (error?.status ?? "ERROR");

    return `FCM ${String(status)} ${code}: ${error?.message ?? "request failed"}`;
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
const postMessage = async (config: FcmConfig, token: string, message: Record<string, unknown>, options: FcmTransportOptions): Promise<string> => {
    const fetchImpl = options.fetch ?? fetch;
    const url = `${config.endpoint ?? DEFAULT_ENDPOINT}/v1/projects/${config.projectId}/messages:send`;
    const body = JSON.stringify({ message });
    const baseDelay = options.retryBaseDelay ?? 250;
    let lastError: Error = new Error("FCM send failed");

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
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
        const text = await response.text();

        if (response.ok) {
            const name = (parseBody(text) as { name?: unknown } | undefined)?.name;

            return typeof name === "string" ? name : "";
        }

        lastError = new Error(failureMessage(response.status, parseBody(text)));

        if (!retryable(response.status)) {
            throw lastError;
        }
    }

    throw lastError;
};

/**
 * An edge-safe FCM HTTP v1 transport. It replaces `@visulima/notification`'s FCM
 * provider, which builds the message from title/body/data only and keeps just the
 * error text of a failed request. This one forwards the per-platform overrides and
 * the structured error code, so a dead token is recognised by `UNREGISTERED` alone.
 */
const createFcmTransport = (config: FcmConfig, options: FcmTransportOptions = {}): FcmTransport => {
    const accessToken = async (): Promise<string> => (config.getAccessToken === undefined ? (config.accessToken ?? "") : await config.getAccessToken());

    const sendTo: FcmTransport["sendTo"] = async (target, payload) => {
        if ("topic" in target && !TOPIC_PATTERN.test(target.topic)) {
            throw new TypeError(`@lunora/notify: FCM topic ${JSON.stringify(target.topic)} must match ${String(TOPIC_PATTERN)}`);
        }

        if ("condition" in target && target.condition.trim() === "") {
            throw new TypeError("@lunora/notify: FCM condition must be a non-empty expression");
        }

        return postMessage(config, await accessToken(), buildFcmMessage(payload, target), options);
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
                    const messageId = await postMessage(config, token, buildFcmMessage(payload, { token: recipient }), options);

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
export { buildFcmMessage, createFcmTransport };
