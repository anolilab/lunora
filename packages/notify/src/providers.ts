import { LunoraError } from "@lunora/errors";
import type { Middleware, Notification, NotificationProviders, NotificationResult, Provider, PushPayload, Result } from "@visulima/notification";
import { createNotification } from "@visulima/notification";
import { retryMiddleware } from "@visulima/notification/middleware";
import type { FcmConfig } from "@visulima/notification/providers/fcm";
import { fcmProvider } from "@visulima/notification/providers/fcm";
import type { WebPushConfig } from "@visulima/notification/providers/web-push";
import { webPushProvider } from "@visulima/notification/providers/web-push";

import { evictOldestEntry } from "../../../shared/evict-oldest";
import type { SsrfResolution } from "../../../shared/ssrf-resolve";
import { resolveHostSsrf } from "../../../shared/ssrf-resolve";
import { isGoneError } from "./subscriptions/normalize";

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

/**
 * Fold two successful group sends into one `NotificationResult`.
 *
 * A mixed-kind push is two provider calls, but the caller gets one receipt — so
 * every field that identifies a delivery has to carry BOTH halves or the receipt
 * silently describes half the send. `messageId`/`provider` join, `response`
 * keeps both bodies, `sent` is the conjunction, and `timestamp` is the later of
 * the two (the moment the whole send finished).
 */
const mergeSendResults = (first: NotificationResult, second: NotificationResult): NotificationResult => {
    const providers = [first.provider, second.provider].filter((provider) => provider !== undefined);
    const recipients = [...(first.recipients ?? []), ...(second.recipients ?? [])];

    return {
        ...first,
        messageId: [first.messageId, second.messageId].join(","),
        response: [first.response, second.response],
        sent: first.sent && second.sent,
        timestamp: new Date(Math.max(first.timestamp.getTime(), second.timestamp.getTime())),
        ...(providers.length > 0 ? { provider: providers.join(",") } : {}),
        ...(recipients.length > 0 ? { recipients } : {}),
    };
};

/**
 * Fold the two group outcomes of a mixed-kind push into the single `Result` the
 * caller gets back.
 *
 * Nothing may be dropped in the fold: two successes merge their delivery data
 * (or the receipt names only half the send), two failures keep both causes, and
 * a mixed outcome reports the failure — a partially delivered send is never
 * reported as a success.
 */
const mergeGroupResults = (webPush: Result<NotificationResult>, fcm: Result<NotificationResult>): Result<NotificationResult> => {
    if (!webPush.success || !fcm.success) {
        if (webPush.success || fcm.success) {
            return webPush.success ? fcm : webPush;
        }

        return { error: new AggregateError([webPush.error, fcm.error], "@lunora/notify: both push target groups failed"), success: false };
    }

    const data = webPush.data === undefined || fcm.data === undefined ? (webPush.data ?? fcm.data) : mergeSendResults(webPush.data, fcm.data);

    return data === undefined ? { success: true } : { data, success: true };
};

/**
 * The failure text of a middleware `Result`, or `undefined` when there is none to
 * read. Providers answer with an `Error` (the engine wraps a provider's own
 * failure in a `NotificationError` whose message carries the provider text
 * verbatim); a bare string is accepted for the same reason `Result.error` is typed
 * `unknown`.
 */
const failureText = (error: unknown): string | undefined => {
    if (error instanceof Error) {
        return error.message;
    }

    return typeof error === "string" ? error : undefined;
};

/**
 * Whether a failed send can never succeed for this recipient — the device
 * unsubscribed or its token was revoked. The facade is about to DELETE the
 * subscription for exactly this signal (see `isGoneError`), so it is the one
 * failure class that is provably not worth a second attempt.
 *
 * Deliberately kind-less: a middleware sees a provider id, not the stored
 * subscription, so the FCM-specific patterns are tested against a web-push failure
 * too. That is safe HERE and not at the prune site: a false positive costs a retry
 * that would probably have failed anyway, where at the prune site it would delete a
 * live subscription. `deliver` still decides pruning with the row's real `kind`.
 */
const isPermanentFailure = (error: unknown): boolean => isGoneError(failureText(error));

/** Consecutive non-permanent failures on one provider before its circuit opens. */
const CIRCUIT_THRESHOLD = 5;

/** How long a provider's circuit stays open before a single trial send. */
const CIRCUIT_RESET_MS = 30_000;

/**
 * A circuit breaker keyed PER PROVIDER that does not count a permanently-gone
 * recipient as evidence the service is down.
 *
 * Both halves replace real behaviour of the engine's own `circuitBreakerMiddleware`,
 * which cannot express either: its counter is closure state of the single instance
 * registered on the engine, shared by every channel, and it counts any `!success`.
 * So two dead devices in a row (whose 4th and 5th attempts are consecutive
 * failures) opened ONE breaker and every `chat`/`webhook`/`inApp` send in that
 * isolate answered `Circuit open` for the next 30 seconds — and the second dead
 * device's own result became `Circuit open` too, which is not a gone signal, so it
 * was never pruned and came back on the next broadcast to do it again. A retry job
 * over known-failing ids reproduced it every redelivery.
 *
 * A breaker is for a provider that is DOWN. An unsubscribed browser is not that.
 */
const perProviderCircuitBreaker = (): Middleware => {
    const states = new Map<string, { failures: number; openedAt: number }>();

    return async (context, next) => {
        const state = states.get(context.provider) ?? { failures: 0, openedAt: 0 };

        states.set(context.provider, state);

        if (state.failures >= CIRCUIT_THRESHOLD) {
            if (Date.now() - state.openedAt < CIRCUIT_RESET_MS) {
                return {
                    error: new LunoraError(
                        "SERVICE_UNAVAILABLE",
                        `@lunora/notify: circuit open for provider "${context.provider}" after ${CIRCUIT_THRESHOLD.toString()} consecutive failures`,
                    ),
                    success: false,
                };
            }

            // Half-open: let exactly one send through. It either clears the
            // counter or puts it straight back over the threshold.
            state.failures = CIRCUIT_THRESHOLD - 1;
        }

        const result = await next(context);

        if (result.success) {
            state.failures = 0;
        } else if (!isPermanentFailure(result.error)) {
            state.failures += 1;

            if (state.failures >= CIRCUIT_THRESHOLD) {
                state.openedAt = Date.now();
            }
        }

        return result;
    };
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
            // The SSRF re-check must cover EVERY target: `notify.send()` hands a
            // caller-shaped message straight to the engine, so a multi-recipient
            // push `to` does reach this router, and the provider POSTs all of
            // them. Guarding only `to[0]` would let every later entry walk past
            // the rebinding check — the one place it is enforced.
            const targets = Array.isArray(payload.to) ? payload.to : [payload.to];

            if (targets.length === 0) {
                // Say what is actually wrong. Routing is per target, so with none
                // both branches below fall through to `pick(undefined)` and a
                // webPush-only app was told it "received an FCM token target but
                // no `fcm` channel is configured" for a send naming no recipient.
                throw new LunoraError("BAD_REQUEST", "@lunora/notify: push send has no recipients — `to` is an empty array");
            }

            const endpoints = targets.map((entry) => webPushEndpoint(entry));

            for (const endpoint of endpoints) {
                if (endpoint !== undefined) {
                    // eslint-disable-next-line no-await-in-loop -- verdicts are memoized per host, so a shared push origin costs one lookup for the whole array
                    await assertPushTargetResolvable(endpoint, options.allowedPushOrigins);
                }
            }

            // ROUTING is per target — the endpoint IS the decision, present means
            // web push, absent means FCM. `ctx.push`'s own fan-out (`deliver`)
            // sends exactly one target per call, but the `notify.send()` path
            // above can carry a mixed-kind `to`, so the targets are partitioned
            // and each group goes to its own provider — routing the whole send by
            // one target's kind would hand FCM tokens to the Web Push transport
            // (or the reverse). A single-kind `to` passes through unchanged.
            const webPushTargets = targets.filter((_, index) => endpoints[index] !== undefined);
            const fcmTargets = targets.filter((_, index) => endpoints[index] === undefined);
            const sampleEndpoint = endpoints.find((endpoint) => endpoint !== undefined);

            if (fcmTargets.length === 0 && sampleEndpoint !== undefined) {
                return pick(sampleEndpoint).send(payload);
            }

            if (webPushTargets.length === 0) {
                return pick(undefined).send(payload);
            }

            // Mixed kinds: narrow `to` per group, keeping the scalar-vs-array
            // shape convention the payload type uses.
            const narrowed = (group: typeof targets): PushPayload => {
                return { ...payload, to: group.length === 1 && group[0] !== undefined ? group[0] : group };
            };

            // Resolve BOTH providers before sending EITHER group: `pick` throws
            // for an unconfigured channel, and throwing that after the other
            // group had already been POSTed would report a partial delivery as a
            // total failure. Failing here means nothing was sent at all.
            const webPushChannel = pick(sampleEndpoint);
            const fcmChannel = pick(undefined);

            // `allSettled`, not two sequential awaits: one transport failing must
            // not stop the other group from being attempted at all. The `async`
            // wrapper matters — `Provider.send` returns `MaybePromise`, so a
            // provider that throws SYNCHRONOUSLY would otherwise escape past
            // `allSettled` (which only catches rejections) and take the sibling
            // group's send down with it.
            const attempt = async (channel: Provider<unknown, PushPayload>, group: typeof targets): Promise<Result<NotificationResult>> =>
                channel.send(narrowed(group));

            const settled = await Promise.allSettled([attempt(webPushChannel, webPushTargets), attempt(fcmChannel, fcmTargets)]);
            const [webPushResult, fcmResult] = settled.map((entry): Result<NotificationResult> =>
                entry.status === "fulfilled" ? entry.value : { error: entry.reason, success: false },
            ) as [Result<NotificationResult>, Result<NotificationResult>];

            // One receipt describes two sends — see `mergeGroupResults` for what
            // the fold must preserve.
            return mergeGroupResults(webPushResult, fcmResult);
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

/** Options for {@link attachResilience}. */
export interface ResilienceOptions {
    /**
     * Retry backoff base, in ms (default 250 — the engine's own). Only a TEST
     * double passes anything else: a mock provider that fails on purpose would
     * otherwise spend the real ~2 s of backoff per recipient to prove which
     * results are retried, which is the one thing the delay says nothing about.
     */
    retryBaseDelay?: number;
}

/**
 * Attach the engine's resilience middleware — retry with backoff, then a circuit
 * breaker to shed load when a push service is down.
 *
 * Exported so a TEST engine is wired by this function rather than by a copy of
 * it. `buildEngine` is the only production caller; a double that assembles a bare
 * `createNotification(...)` exercises none of this, which is how a broadcast could
 * spend four POSTs and two seconds on a subscription already known to be dead and
 * nothing noticed.
 */
export const attachResilience = (engine: Notification, options: ResilienceOptions = {}): Notification =>
    engine
        // `shouldRetry` is the difference between "the push service hiccuped" and
        // "this device is gone". Without it every 410/404 cost the full retry
        // budget — four POSTs and ~2.2 s of backoff each — against an endpoint the
        // very next line of the facade deletes, and those attempts were what fed
        // the breaker below.
        .use(retryMiddleware({ baseDelay: options.retryBaseDelay, shouldRetry: (error) => !isPermanentFailure(error) }))
        .use(perProviderCircuitBreaker());

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

    return attachResilience(createNotification(providers));
};
