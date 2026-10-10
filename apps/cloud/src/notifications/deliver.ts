/**
 * Channel validation, per-kind request building, and the outbound send for
 * lifecycle notifications. Pure request construction (no I/O) so each payload
 * shape is unit-testable; {@link deliverNotification} is the one place that
 * performs the POST. It refuses unsafe URLs, never follows redirects, and tags
 * each failure as retryable or permanent so the sweep knows whether to try again.
 */
import { isSafeWebhookUrl } from "../telemetry/alerts";
import type { NotificationKind, NotificationMessage } from "./events";

/** Discord rejects a message `content` over 2000 characters. */
const DISCORD_CONTENT_LIMIT = 1900;

/** Upper bound on one outbound request, so a stalled endpoint fails its row instead of holding the sweep. */
const DELIVERY_TIMEOUT_MS = 10_000;

const TELEGRAM_API = "https://api.telegram.org";

/** A numeric chat id (groups are negative) or a public channel `@name`. */
const TELEGRAM_CHAT = /^(?:-?\d+|@\w{5,})$/u;

/** Discord webhook URLs live on these hosts under `/api/webhooks/`. */
const DISCORD_HOSTS = new Set(["canary.discord.com", "discord.com", "discordapp.com", "ptb.discord.com"]);

/** A channel as the sweep sees it, with its secret already decrypted. */
export interface ChannelTarget {
    destination: string;
    kind: NotificationKind;
    secret?: string;
}

/** An outbound request, fully formed. */
export interface NotificationRequest {
    body: string;
    headers: Record<string, string>;
    url: string;
}

/**
 * A failed send. `retryable` is true for transient failures (network errors,
 * timeouts, 429 and 5xx); a refused destination or a 4xx is permanent, since
 * retrying the same request cannot succeed.
 */
export class NotificationDeliveryError extends Error {
    readonly retryable: boolean;

    constructor(message: string, retryable: boolean) {
        super(message);
        this.name = "NotificationDeliveryError";
        this.retryable = retryable;
    }
}

/**
 * Check a channel's destination for its kind. Returns the reason it is refused,
 * or `null` when it is acceptable. Telegram needs a bot token alongside the chat
 * id; `hasSecret` says whether one is stored (the plaintext never reaches here).
 */
export const invalidDestinationReason = (kind: NotificationKind, destination: string, hasSecret: boolean): string | null => {
    switch (kind) {
        case "discord": {
            let url: URL;

            try {
                url = new URL(destination);
            } catch {
                return "discord destination must be a webhook URL";
            }

            return url.protocol === "https:" && DISCORD_HOSTS.has(url.hostname) && url.pathname.startsWith("/api/webhooks/")
                ? null
                : "discord destination must be a discord.com webhook URL";
        }
        case "telegram": {
            if (!TELEGRAM_CHAT.test(destination.trim())) {
                return "telegram chat id must be a numeric id or a @channelname";
            }

            return hasSecret ? null : "telegram needs a bot token";
        }
        default: {
            return isSafeWebhookUrl(destination) ? null : `${kind} destination must be an https:// URL to a public host`;
        }
    }
};

/** Hex HMAC-SHA256 over `${timestamp}.${body}`, the signed-webhook scheme receivers verify. */
export const signWebhookBody = async (secret: string, timestamp: number, body: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${String(timestamp)}.${body}`));

    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Build the request for one channel + message. Discord suppresses every mention
 * so an org or project name can't ping `@everyone`; Telegram sends plain text
 * (no `parse_mode`, no link preview). Generic webhooks are signed so a receiver
 * can reject forged or replayed deliveries: `Lunora-Signature: t=UNIX_SECONDS,v1=HEX_DIGEST`.
 * `now` is epoch milliseconds, as `Date.now()` returns it; the signed timestamp is
 * truncated to seconds, the unit receivers expect.
 */
export const notificationRequestFor = async (channel: ChannelTarget, message: NotificationMessage, now: number): Promise<NotificationRequest> => {
    switch (channel.kind) {
        case "discord": {
            const content = `**${message.subject}**\n${message.body}`.slice(0, DISCORD_CONTENT_LIMIT);

            return {
                body: JSON.stringify({ allowed_mentions: { parse: [] }, content }),
                headers: { "content-type": "application/json" },
                url: channel.destination,
            };
        }
        case "slack": {
            return {
                body: JSON.stringify({ text: `${message.subject}\n${message.body}` }),
                headers: { "content-type": "application/json" },
                url: channel.destination,
            };
        }
        case "telegram": {
            return {
                body: JSON.stringify({
                    chat_id: channel.destination.trim(),
                    link_preview_options: { is_disabled: true },
                    text: `${message.subject}\n\n${message.body}`,
                }),
                headers: { "content-type": "application/json" },
                url: `${TELEGRAM_API}/bot${channel.secret ?? ""}/sendMessage`,
            };
        }
        default: {
            const timestamp = Math.floor(now / 1000);
            const body = JSON.stringify({ body: message.body, event: message.event, subject: message.subject, timestamp });
            const signature = await signWebhookBody(channel.secret ?? "", timestamp, body);

            return {
                body,
                headers: { "content-type": "application/json", "lunora-signature": `t=${String(timestamp)},v1=${signature}` },
                url: channel.destination,
            };
        }
    }
};

/** Statuses worth another attempt: rate limiting and server-side faults. */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * POST a request. Refuses an unsafe URL before fetching (permanent), treats a
 * network error or timeout as retryable, and any non-2xx as a failure classed by
 * {@link isRetryableStatus} (redirects aren't followed, so a 3xx is permanent).
 * The error names only the status: the URL can carry a bot token or webhook secret.
 */
export const deliverNotification = async (fetchImpl: typeof globalThis.fetch, request: NotificationRequest): Promise<void> => {
    if (!isSafeWebhookUrl(request.url)) {
        throw new NotificationDeliveryError("unsafe notification destination", false);
    }

    let response: Response;

    try {
        response = await fetchImpl(request.url, {
            body: request.body,
            headers: request.headers,
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
    } catch {
        throw new NotificationDeliveryError("notification endpoint unreachable or timed out", true);
    }

    if (!response.ok) {
        throw new NotificationDeliveryError(`notification endpoint responded ${String(response.status)}`, isRetryableStatus(response.status));
    }
};

/**
 * A destination safe to show in the dashboard. A URL keeps its host and the last
 * four characters of its path, since the path holds the credential; a Telegram
 * chat id is not a secret and is shown whole.
 */
export const maskDestination = (kind: NotificationKind, destination: string): string => {
    if (kind === "telegram") {
        return destination;
    }

    try {
        const url = new URL(destination);

        return `${url.protocol}//${url.host}/…${destination.slice(-4)}`;
    } catch {
        return "…";
    }
};
