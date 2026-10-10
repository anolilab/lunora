/**
 * Lifecycle notification events and the pure rules that route them. An org's
 * channels subscribe to a subset of these; a state change in the control plane
 * (a deploy going live, a domain verifying, a preview expiring) enqueues one
 * delivery per subscribed channel. Kept free of I/O so the subscription rule and
 * the message text are unit-testable, and shared by the lunora mutations (which
 * enqueue) and the edge sweep (which delivers).
 */

/** Events an org can subscribe a channel to. */
export const NOTIFICATION_EVENTS = [
    "deployment.live",
    "deployment.failed",
    "deployment.rolled_back",
    "domain.verified",
    "domain.failed",
    "preview.expired",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Delivery targets. `telegram` and `discord` get their own payload shapes; `slack` and `webhook` are JSON POSTs. */
export const NOTIFICATION_KINDS = ["discord", "slack", "telegram", "webhook"] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Narrow an untrusted value to a known event name. */
export const isNotificationEvent = (value: unknown): value is NotificationEvent =>
    typeof value === "string" && (NOTIFICATION_EVENTS as readonly string[]).includes(value);

/** Narrow an untrusted value to a known channel kind. */
export const isNotificationKind = (value: unknown): value is NotificationKind =>
    typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);

/** Human label for each event, used as the message subject. */
export const NOTIFICATION_LABEL: Record<NotificationEvent | "test", string> = {
    "deployment.failed": "Deployment failed",
    "deployment.live": "Deployment live",
    "deployment.rolled_back": "Deployment rolled back",
    "domain.failed": "Domain failed",
    "domain.verified": "Domain verified",
    "preview.expired": "Preview expired",
    test: "Test notification",
};

/** A rendered message. `body` carries only non-secret facts: names, versions, public URLs. */
export interface NotificationMessage {
    body: string;
    event: NotificationEvent | "test";
    subject: string;
}

/** The facts a message is rendered from. `detail` is one short, non-secret line. */
export interface NotificationFacts {
    detail?: string;
    project: string;
}

/**
 * Render an event into the subject/body every channel shares. Error text is
 * deliberately never included: a failure links to the dashboard log instead,
 * because error strings can carry secrets or request paths.
 */
export const renderNotification = (event: NotificationEvent | "test", facts: NotificationFacts): NotificationMessage => {
    const label = NOTIFICATION_LABEL[event];
    const lines = [`${label} for "${facts.project}" on Lunora Cloud.`];

    if (facts.detail) {
        lines.push(facts.detail);
    }

    return { body: lines.join("\n"), event, subject: `[Lunora] ${label}: ${facts.project}` };
};

/** The subset of a stored channel the routing rules read. */
export interface RoutableChannel {
    _id: string;
    enabled: boolean;
    events: ReadonlyArray<NotificationEvent>;
}

/** Channels that should receive `event`: enabled and subscribed to it. */
export const channelsForEvent = <T extends RoutableChannel>(channels: ReadonlyArray<T>, event: NotificationEvent): T[] =>
    channels.filter((channel) => channel.enabled && channel.events.includes(event));
