import { LunoraError } from "@lunora/errors";
import type { Notification, NotificationProviders, Provider, PushPayload } from "@visulima/notification";
import { createNotification } from "@visulima/notification";
import { circuitBreakerMiddleware, retryMiddleware } from "@visulima/notification/middleware";
import type { FcmConfig } from "@visulima/notification/providers/fcm";
import { fcmProvider } from "@visulima/notification/providers/fcm";
import type { WebPushConfig } from "@visulima/notification/providers/web-push";
import { webPushProvider } from "@visulima/notification/providers/web-push";

import { evictOldestEntry } from "../../../shared/evict-oldest";
import type { SsrfResolution } from "../../../shared/ssrf-resolve";
import { resolveHostSsrf } from "../../../shared/ssrf-resolve";

/**
 * The web-push `endpoint` of a routed target, or `undefined` when the target is
 * an opaque FCM registration token instead.
 *
 * This is BOTH the routing predicate and the endpoint accessor, deliberately: the
 * two used to be separate functions that each JSON-parsed the target and each
 * encoded its own idea of "what a web-push target looks like" — and they had
 * already drifted (one demanded `keys` for the string form but not the object
 * form). One parse, one shape, one place to change it.
 */
const webPushEndpoint = (target: unknown): string | undefined => {
    let parsed: unknown = target;

    if (typeof target === "string") {
        // An FCM token is an opaque string, never JSON — skip the parse entirely.
        if (!target.startsWith("{")) {
            return undefined;
        }

        try {
            parsed = JSON.parse(target);
        } catch {
            return undefined;
        }
    }

    const endpoint = (parsed as { endpoint?: unknown } | null | undefined)?.endpoint;

    return typeof endpoint === "string" ? endpoint : undefined;
};

/**
 * Per-isolate memo of the send-time rebinding verdict, keyed by hostname. A
 * `broadcast` fans out to every device, and real deployments share a handful of
 * push-service origins across all of them — one DoH round-trip per host per
 * isolate instead of one per device.
 *
 * Only a CONCLUSIVE verdict is stored. A failed DoH lookup is deliberately not
 * cached: it is a fallback to the register-time string guard, not a finding, and
 * memoizing it would let one transient resolver blip disable the re-check for
 * that host for the isolate's life.
 *
 * Bounded via the shared FIFO evictor — the key is a registration-time,
 * caller-influenced hostname, so an unbounded map would grow with distinct
 * attacker-supplied hosts.
 *
 * ponytail: no TTL. An isolate lives minutes, so a host that rebinds mid-isolate
 * keeps a stale verdict for that long; add an expiry if isolates ever get long
 * enough for that to matter.
 */
const rebindVerdicts = new Map<string, Promise<SsrfResolution>>();

/** How many distinct push-service hosts one isolate remembers a verdict for. */
const REBIND_VERDICT_CAPACITY = 256;

/**
 * Send-time SSRF re-check for a stored web-push endpoint — the second half of the
 * boundary `assertPushEndpoint` opens at register time.
 *
 * Register-time validation is a STRING classifier: a public hostname that resolves
 * to a private/internal IP passes it, and even a host that resolved public then can
 * be re-pointed afterwards. Since every send `fetch`-POSTs the caller-supplied
 * endpoint (and `broadcast` does it once per device), the resolved address has to be
 * re-checked here, where the request actually goes out.
 *
 * Skipped when `allowedPushOrigins` is configured: that exact-origin allowlist is
 * the stronger guard and may legitimately name an internal push service.
 */
const assertPushTargetResolvable = async (endpoint: string, allowedPushOrigins?: string[]): Promise<void> => {
    if (allowedPushOrigins !== undefined && allowedPushOrigins.length > 0) {
        return;
    }

    let hostname: string;

    try {
        ({ hostname } = new URL(endpoint));
    } catch {
        return;
    }

    const cached = rebindVerdicts.get(hostname);
    const pending = cached ?? resolveHostSsrf(hostname);
    const resolution = await pending;

    // Cache only what was actually learned (see the memo's docblock).
    if (cached === undefined && resolution.kind !== "unknown") {
        evictOldestEntry(rebindVerdicts, REBIND_VERDICT_CAPACITY);
        rebindVerdicts.set(hostname, pending);
    }

    if (resolution.kind === "private") {
        throw new LunoraError(
            "FORBIDDEN",
            `@lunora/notify: web-push endpoint host "${hostname}" resolves to a private/internal address (${resolution.address}); refusing to send (DNS-rebinding guard)`,
        );
    }
};

/** Options for {@link routingPushProvider}. */
export interface RoutingPushOptions {
    /**
     * The definition's exact-origin allowlist, when configured. Its presence
     * disables the send-time rebinding re-check (see {@link assertPushTargetResolvable}).
     */
    allowedPushOrigins?: string[];
    fcm?: Provider<unknown, PushPayload>;
    webPush?: Provider<unknown, PushPayload>;
}

/**
 * A composite push {@link Provider} that dispatches each send to the Web Push or
 * FCM provider by the shape of the payload `to` target — so a single `push`
 * channel on the {@link Notification} facade transparently handles both browser
 * subscriptions and mobile device tokens, and the engine's middleware wraps them
 * uniformly.
 */
export const routingPushProvider = (options: RoutingPushOptions): Provider<unknown, PushPayload> => {
    const pick = (endpoint: string | undefined): Provider<unknown, PushPayload> => {
        const provider = endpoint === undefined ? options.fcm : options.webPush;

        if (provider === undefined) {
            throw new Error(
                endpoint === undefined
                    ? "@lunora/notify: received an FCM token target but no `fcm` channel is configured"
                    : "@lunora/notify: received a web-push target but no `webPush` channel is configured",
            );
        }

        return provider;
    };

    return {
        channel: "push",
        id: "lunora-push-router",
        initialize: async () => {
            await options.webPush?.initialize();
            await options.fcm?.initialize();
        },
        isAvailable: () => (options.webPush ?? options.fcm) !== undefined,
        send: async (payload) => {
            // A multi-recipient `to` can mix kinds; our facade sends one target per
            // call, so route on the first (single) target here. The endpoint IS the
            // routing decision — present means web push, absent means FCM.
            const target = Array.isArray(payload.to) ? payload.to[0] : payload.to;
            const endpoint = webPushEndpoint(target);

            if (endpoint !== undefined) {
                await assertPushTargetResolvable(endpoint, options.allowedPushOrigins);
            }

            return pick(endpoint).send(payload);
        },
    };
};

/** A resolved, ready-to-wire set of channel configs (edge-safe channels only). */
export interface ResolvedProviders {
    /** The definition's `allowedPushOrigins`, threaded to the push router's send-time SSRF guard. */
    allowedPushOrigins?: string[];
    chat?: Provider;
    fcm?: FcmConfig;
    inApp?: Provider;
    webhook?: Provider;
    webPush?: WebPushConfig;
}

/**
 * Assemble the `@visulima/notification` engine from resolved channel configs and
 * attach the reused retry + circuit-breaker middleware. Only edge-safe channels
 * are wired (Web Push, FCM, chat, in-app, webhook); APNs and SMS are excluded
 * from the edge facade by construction.
 */
export const buildEngine = (resolved: ResolvedProviders): Notification => {
    const webPush = resolved.webPush === undefined ? undefined : webPushProvider(resolved.webPush);
    const fcm = resolved.fcm === undefined ? undefined : fcmProvider(resolved.fcm);

    const providers: NotificationProviders = {};

    if (webPush !== undefined || fcm !== undefined) {
        providers.push = routingPushProvider({ allowedPushOrigins: resolved.allowedPushOrigins, fcm, webPush });
    }

    if (resolved.chat !== undefined) {
        providers.chat = resolved.chat;
    }

    if (resolved.inApp !== undefined) {
        providers.inapp = resolved.inApp;
    }

    if (resolved.webhook !== undefined) {
        providers.webhook = resolved.webhook;
    }

    const engine = createNotification(providers);

    // Reuse the engine's own resilience middleware (Phase 3): retry with backoff,
    // then a circuit breaker to shed load when a push service is down.
    engine.use(retryMiddleware()).use(circuitBreakerMiddleware());

    return engine;
};
