import type { NotificationKind, NotificationMessage } from "./events";

/** A channel as the outbox needs it: where the row is addressed and what kind it is. */
export interface OutboxChannel<TId extends string> {
    _id: TId;
    kind: NotificationKind;
}

/**
 * The `notificationDeliveries` row a queued message becomes. Shared by the lunora
 * mutations (which insert through `ctx.db`) and the edge domain sweep (which
 * inserts through the control-plane store), so both write identical rows.
 */
export const pendingDeliveryRow = <TChannel extends string, TOrganization extends string>(
    channel: OutboxChannel<TChannel>,
    message: NotificationMessage,
    organizationId: TOrganization,
    now: number,
): {
    attempts: number;
    body: string;
    channelId: TChannel;
    createdAt: number;
    event: NotificationMessage["event"];
    kind: NotificationKind;
    nextAttemptAt: number;
    organizationId: TOrganization;
    status: "pending";
    subject: string;
    updatedAt: number;
} => ({
    attempts: 0,
    body: message.body,
    channelId: channel._id,
    createdAt: now,
    event: message.event,
    kind: channel.kind,
    nextAttemptAt: now,
    organizationId,
    status: "pending",
    subject: message.subject,
    updatedAt: now,
});
