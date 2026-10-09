/**
 * The recording `ctx.notify` / `ctx.push` the `lunoraTest` harness hands every
 * context. Built by `@lunora/notify`'s own `createNotify` from the app's
 * `lunora/notify.ts` definition, so register/list/unregister/broadcast and the
 * "channel not configured" refusal behave as in production — only two things
 * are swapped: the delivery engine records each send and reports it accepted
 * instead of reaching a push service, and subscriptions live in an in-memory
 * store owned by the harness instead of the definition's `store`.
 */
import type { LunoraNotify, LunoraPush, NotifyDefinition, NotifyLogger, NotifyMetrics } from "@lunora/notify";
import { createNotify, memorySubscriptionStore } from "@lunora/notify";
import type { ChannelPayloadMap, ChannelType, NotificationProviders, Provider } from "@visulima/notification";
import { createNotification } from "@visulima/notification";

/** The channels `ctx.notify` can deliver on. */
type NotifyChannel = "chat" | "inapp" | "push" | "webhook";

/** One delivery a handler made through `ctx.notify` / `ctx.push`. For push, `payload.to` is the device target. */
type SentNotification = { [C in NotifyChannel]: { channel: C; payload: ChannelPayloadMap[C] } }[NotifyChannel];

/** Inspect what handlers delivered through `ctx.notify` / `ctx.push`. */
interface FakeNotifyControls {
    /** Forget every recorded delivery (registered subscriptions are kept). */
    clear: () => void;
    /** Recorded deliveries in send order, optionally only those on `channel`. */
    sent: (channel?: NotifyChannel) => SentNotification[];
}

const createFakeNotify = (
    definition: NotifyDefinition,
    env: Record<string, unknown>,
    telemetry: { log: NotifyLogger; metrics: NotifyMetrics },
): { controls: FakeNotifyControls; notify: LunoraNotify; push: LunoraPush } => {
    const deliveries: SentNotification[] = [];

    const recorder = (channel: NotifyChannel): Provider => {
        return {
            channel,
            id: `lunora-testing-${channel}`,
            initialize: () => undefined,
            isAvailable: () => true,
            send: (payload) => {
                deliveries.push({ channel, payload } as SentNotification);

                return { data: { messageId: `${channel}-${String(deliveries.length)}`, sent: true, timestamp: new Date() }, success: true };
            },
        };
    };

    // Push is always wired (`defineNotify` refuses a definition without a push
    // channel); the others only when the definition declares them, so a send on
    // an undeclared channel is refused here as it is in production.
    const providers: NotificationProviders = { push: recorder("push") };
    const optional: [keyof NotifyDefinition, Exclude<NotifyChannel, "push">][] = [
        ["chat", "chat"],
        ["inApp", "inapp"],
        ["webhook", "webhook"],
    ];

    for (const [key, channel] of optional) {
        if (definition[key] !== undefined) {
            (providers as Record<ChannelType, Provider>)[channel] = recorder(channel);
        }
    }

    const store = memorySubscriptionStore();
    // A fresh definition object per harness: `createNotify` memoizes its store per
    // definition identity, so harnesses never share subscriptions.
    const { notify, push } = createNotify({ ...definition, store: () => store }, env, {
        engine: createNotification(providers),
        log: telemetry.log,
        metrics: telemetry.metrics,
        silent: true,
    });

    const controls: FakeNotifyControls = {
        clear: () => {
            deliveries.length = 0;
        },
        sent: (channel) => (channel === undefined ? [...deliveries] : deliveries.filter((delivery) => delivery.channel === channel)),
    };

    return { controls, notify, push };
};

export type { FakeNotifyControls, NotifyChannel, SentNotification };
export { createFakeNotify };
