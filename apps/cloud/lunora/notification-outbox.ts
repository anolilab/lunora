import type { NotificationEvent, NotificationFacts, NotificationKind, NotificationMessage } from "../src/notifications/events";
import { channelsForEvent, renderNotification } from "../src/notifications/events";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";

/**
 * Write side of the notification outbox. A lifecycle mutation (deploy live, domain
 * verified, preview expired) calls {@link enqueueNotification}, which inserts one
 * `pending` delivery per enabled channel subscribed to the event. Nothing is sent
 * here: a mutation can't do I/O, so the every-minute edge sweep
 * (`src/notifications/sweep.ts`) delivers the rows and stamps the outcome.
 */

interface ChannelRow {
    _id: Id<"notificationChannels">;
    enabled: boolean;
    events: NotificationEvent[];
    kind: NotificationKind;
}

/** Insert one pending delivery for a channel. */
export const queueDelivery = (
    context: MutationContext,
    channel: ChannelRow,
    message: NotificationMessage,
    organizationId: Id<"organizations">,
): Promise<Id<"notificationDeliveries">> =>
    context.db.insert("notificationDeliveries", {
        attempts: 0,
        body: message.body,
        channelId: channel._id,
        createdAt: context.now,
        event: message.event,
        kind: channel.kind,
        nextAttemptAt: context.now,
        organizationId,
        status: "pending",
        subject: message.subject,
        updatedAt: context.now,
    });

/**
 * Queue `event` for every enabled channel in the org that subscribes to it.
 * Returns how many deliveries were queued. Call it only on the state transition
 * itself, so a retried mutation does not announce the same event twice.
 */
export const enqueueNotification = async (
    context: MutationContext,
    organizationId: Id<"organizations">,
    event: NotificationEvent,
    facts: NotificationFacts,
): Promise<number> => {
    const { page } = await context.db.notificationChannels.findMany({ where: { organizationId } });
    const targets = channelsForEvent(page as unknown as ChannelRow[], event);
    const message = renderNotification(event, facts);

    for (const channel of targets) {
        // eslint-disable-next-line no-await-in-loop -- a handful of channels per org; sequential keeps writes simple
        await queueDelivery(context, channel, message, organizationId);
    }

    return targets.length;
};
