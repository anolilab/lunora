/**
 * The recording `ctx.notify` / `ctx.push` the `lunoraTest` harness hands every
 * context. Built by `@lunora/notify`'s own `createNotify` from the app's
 * `lunora/notify.ts` definition, so register/list/unregister/broadcast and the
 * "channel not configured" refusal behave as in production. Swapped: the
 * delivery engine records each send and reports it accepted instead of reaching
 * a push service (so no send-time DNS re-check, retry or circuit breaker), and
 * subscriptions live in an in-memory store owned by the harness instead of the
 * definition's `store`.
 */
import { LunoraError } from "@lunora/errors";
import type { LunoraNotify, LunoraPush, NotifyDefinition } from "@lunora/notify";
import { createNotify, memorySubscriptionStore } from "@lunora/notify";
import type { ChannelPayloadMap, ChannelType, NotificationProviders, Provider, PushPayload } from "@visulima/notification";
import { createNotification } from "@visulima/notification";

import { stubProxy, unavailable } from "./context-fakes";

/** The channels `ctx.notify` can deliver on. */
type NotifyChannel = Extract<ChannelType, "chat" | "inapp" | "push" | "webhook">;

/**
 * One delivery a handler made through `ctx.notify` / `ctx.push`. For push,
 * `payload.to` is the device target: the FCM token, or for Web Push the
 * JSON-stringified subscription (keys included).
 */
type SentNotification = { [C in NotifyChannel]: { channel: C; payload: ChannelPayloadMap[C] } }[NotifyChannel];

/** Inspect what handlers delivered through `ctx.notify` / `ctx.push`. */
interface FakeNotifyControls {
    /** Forget every recorded delivery (registered subscriptions are kept). */
    clear: () => void;
    /** Recorded deliveries in send order, optionally only those on `channel`. Throws when `options.notify` was not passed. */
    sent: (channel?: NotifyChannel) => SentNotification[];
}

/** `ctx.notify` / `ctx.push`: not on the base contexts — codegen adds them to every context when `lunora/notify.ts` exists. */
interface NotifySurfaces {
    notify: LunoraNotify;
    push: LunoraPush;
}

const OPTION = "notify";

/** A target's Web Push endpoint, or `undefined` for an FCM token — the same split `@lunora/notify`'s push router makes. */
const webPushEndpoint = (target: unknown): string | undefined => {
    let parsed: unknown = target;

    if (typeof target === "string") {
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

/** A channel config resolved the way production does: a factory is called with `env`, and `undefined` leaves the channel unwired. */
const resolve = (config: unknown, env: Record<string, unknown>): unknown =>
    typeof config === "function" ? (config as (env: unknown) => unknown)(env) : config;

const createRecordingNotify = (definition: NotifyDefinition, env: Record<string, unknown>): { controls: FakeNotifyControls; surfaces: NotifySurfaces } => {
    const deliveries: SentNotification[] = [];

    const record = (channel: NotifyChannel, payload: unknown): Awaited<ReturnType<Provider["send"]>> => {
        // `Provider.send`'s payload is not narrowed by channel; each recorder only ever sees its own channel's.
        // Copy it now: a handler that changes the object after sending must not rewrite this delivery.
        deliveries.push({ channel, payload: structuredClone(payload) } as SentNotification);

        return { data: { messageId: `${channel}-${String(deliveries.length)}`, sent: true, timestamp: new Date() }, success: true };
    };

    const recorder = (channel: NotifyChannel): Provider => {
        return { channel, id: `lunora-testing-${channel}`, initialize: () => undefined, isAvailable: () => true, send: (payload) => record(channel, payload) };
    };

    const hasWebPush = resolve(definition.webPush, env) !== undefined;
    const hasFcm = resolve(definition.fcm, env) !== undefined;

    // Push routes each target to its transport and refuses one the definition did
    // not configure, as production's router does — a webPush-only app that
    // registered an FCM token fails its sends there, so it must fail them here.
    const push: Provider<unknown, PushPayload> = {
        ...recorder("push"),
        send: (payload) => {
            const targets = Array.isArray(payload.to) ? payload.to : [payload.to];

            if (targets.length === 0) {
                throw new LunoraError("BAD_REQUEST", "@lunora/notify: push send has no recipients — `to` is an empty array");
            }

            for (const target of targets) {
                const isWebPush = webPushEndpoint(target) !== undefined;

                if (isWebPush ? !hasWebPush : !hasFcm) {
                    throw new Error(
                        isWebPush
                            ? "@lunora/notify: received a web-push target but no `webPush` channel is configured"
                            : "@lunora/notify: received an FCM token target but no `fcm` channel is configured",
                    );
                }
            }

            return record("push", payload);
        },
    };

    // Wired exactly when production's `buildEngine` would wire them: push when
    // either transport resolves, the others when their factory returns a provider.
    const providers: NotificationProviders = {
        ...(hasWebPush || hasFcm ? { push } : {}),
        ...(resolve(definition.chat, env) === undefined ? {} : { chat: recorder("chat") }),
        ...(resolve(definition.inApp, env) === undefined ? {} : { inapp: recorder("inapp") }),
        ...(resolve(definition.webhook, env) === undefined ? {} : { webhook: recorder("webhook") }),
    };

    const store = memorySubscriptionStore();
    // A fresh definition object per harness: `createNotify` memoizes its store per
    // definition identity, so harnesses never share subscriptions.
    const { notify, push: pushFacade } = createNotify({ ...definition, store: () => store }, env, { engine: createNotification(providers), silent: true });

    return {
        controls: {
            clear: () => {
                deliveries.length = 0;
            },
            sent: (channel) => (channel === undefined ? [...deliveries] : deliveries.filter((delivery) => delivery.channel === channel)),
        },
        surfaces: { notify, push: pushFacade },
    };
};

/**
 * The recording `ctx.notify` / `ctx.push` for `definition`; without one, stubs
 * that throw naming the option — and a `sent()` that throws too, so a handler
 * swallowing the stub's error cannot make "nothing was sent" pass vacuously.
 */
const createFakeNotify = (
    definition: NotifyDefinition | undefined,
    env: Record<string, unknown>,
): { controls: FakeNotifyControls; surfaces: NotifySurfaces } => {
    if (definition !== undefined) {
        return createRecordingNotify(definition, env);
    }

    return {
        controls: { clear: () => unavailable("notify", OPTION), sent: () => unavailable("notify", OPTION) },
        surfaces: { notify: stubProxy("notify", OPTION) as LunoraNotify, push: stubProxy("push", OPTION) as LunoraPush },
    };
};

export type { FakeNotifyControls, NotifyChannel, NotifySurfaces, SentNotification };
export { createFakeNotify };
