/**
 * `ctx.notify` / `ctx.push` for the `lunoraTest` harness: the real `@lunora/notify`
 * facade (`createNotify`) over its in-memory subscription store, with every
 * channel provider swapped for one that records the payload and reports success —
 * so nothing reaches Web Push, FCM or a webhook.
 */
import type { LunoraNotify, LunoraPush, NotifyDefinition } from "@lunora/notify";
import { createNotify, memorySubscriptionStore } from "@lunora/notify";
import type { ChannelType, Provider } from "@visulima/notification";
import { createNotification } from "@visulima/notification";

import { noopLog, noopMetrics } from "./context-fakes";

/** One delivery the facade handed a provider: the channel and the payload (for push, including the resolved `to`). */
interface RecordedNotification {
    channel: ChannelType;
    payload: unknown;
}

/** Harness controls for the recorded `ctx.notify` / `ctx.push` deliveries. */
interface FakeNotifyControls {
    /** Every delivery, in send order — only `channel`'s when given (`"push"`, `"chat"`, `"inapp"`, `"webhook"`). */
    sent: (channel?: ChannelType) => RecordedNotification[];
}

const recordingProvider = (channel: ChannelType, log: RecordedNotification[]): Provider => {
    return {
        channel,
        id: `lunora-testing-${channel}`,
        initialize: () => undefined,
        isAvailable: () => true,
        send: (payload) => {
            log.push({ channel, payload });

            return { data: { messageId: `${channel}-${String(log.length)}`, sent: true, timestamp: new Date() }, success: true };
        },
    };
};

/**
 * Build `ctx.notify` / `ctx.push` and their `harness.notify` controls. Push is
 * always wired; chat / in-app / webhook only when `definition` configures them,
 * so an unconfigured channel still rejects as it does in production. The
 * definition's `store` is replaced by a fresh in-memory store per harness.
 */
const createFakeNotify = (
    definition: NotifyDefinition | undefined,
    env: Record<string, unknown> | undefined,
): { controls: FakeNotifyControls; notify: LunoraNotify; push: LunoraPush } => {
    const log: RecordedNotification[] = [];
    const store = memorySubscriptionStore();
    const engine = createNotification({
        chat: definition?.chat === undefined ? undefined : recordingProvider("chat", log),
        inapp: definition?.inApp === undefined ? undefined : recordingProvider("inapp", log),
        push: recordingProvider("push", log),
        webhook: definition?.webhook === undefined ? undefined : recordingProvider("webhook", log),
    });
    const { notify, push } = createNotify({ ...definition, isLunoraNotify: true, store: () => store }, env ?? {}, {
        engine,
        log: noopLog,
        metrics: noopMetrics,
        silent: true,
    });

    return {
        controls: { sent: (channel) => log.filter((entry) => channel === undefined || entry.channel === channel) },
        notify,
        push,
    };
};

export type { FakeNotifyControls, RecordedNotification };
export { createFakeNotify };
