import type { Notification, NotificationProviders, Provider, PushPayload } from "@visulima/notification";
import { createNotification } from "@visulima/notification";
import { circuitBreakerMiddleware, retryMiddleware } from "@visulima/notification/middleware";
import type { FcmConfig } from "@visulima/notification/providers/fcm";
import { fcmProvider } from "@visulima/notification/providers/fcm";
import type { WebPushConfig } from "@visulima/notification/providers/web-push";
import { webPushProvider } from "@visulima/notification/providers/web-push";

/**
 * A single push target is a web-push subscription when it JSON-parses to an object
 * carrying an `endpoint` + `keys`; anything else (an opaque FCM registration
 * token) routes to FCM. Matches the `to` shapes the two providers accept.
 */
const isWebPushTarget = (target: unknown): boolean => {
    if (typeof target !== "string") {
        return typeof target === "object" && target !== null && "endpoint" in target;
    }

    if (!target.startsWith("{")) {
        return false;
    }

    try {
        const parsed = JSON.parse(target) as { endpoint?: unknown; keys?: unknown };

        return typeof parsed.endpoint === "string" && typeof parsed.keys === "object";
    } catch {
        return false;
    }
};

/** Options for {@link routingPushProvider}. */
export interface RoutingPushOptions {
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
    const pick = (target: unknown): Provider<unknown, PushPayload> => {
        const provider = isWebPushTarget(target) ? options.webPush : options.fcm;

        if (provider === undefined) {
            throw new Error(
                isWebPushTarget(target)
                    ? "@lunora/notify: received a web-push target but no `webPush` channel is configured"
                    : "@lunora/notify: received an FCM token target but no `fcm` channel is configured",
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
        send: (payload) => {
            // A multi-recipient `to` can mix kinds; our facade sends one target per
            // call, so route on the first (single) target here.
            const target = Array.isArray(payload.to) ? payload.to[0] : payload.to;

            return pick(target).send(payload);
        },
    };
};

/** A resolved, ready-to-wire set of channel configs (edge-safe channels only). */
export interface ResolvedProviders {
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
        providers.push = routingPushProvider({ fcm, webPush });
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
