import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import type { NotificationEvent, NotificationKind } from "../notifications/events";
import { NOTIFICATION_EVENTS, NOTIFICATION_KINDS } from "../notifications/events";
import { AsyncList } from "./AsyncList";
import { formatDateTime } from "./format";
import { Field, FieldForm, FormError, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import { COLUMN_LABEL } from "./section-classes";
import type { OrgId } from "./types";

/** Upper bound on the create request, so a wedged edge route can't leave the form spinning. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Human labels for each subscribable event. */
const EVENT_LABELS: Record<NotificationEvent, string> = {
    "deployment.failed": "Deployment failed",
    "deployment.live": "Deployment live",
    "deployment.rolled_back": "Rolled back",
    "domain.failed": "Domain failed",
    "domain.verified": "Domain verified",
    "preview.expired": "Preview expired",
};

const KIND_LABELS: Record<NotificationKind, string> = {
    discord: "Discord",
    slack: "Slack",
    telegram: "Telegram",
    webhook: "Webhook",
};

/** Placeholder hint for the destination field, which holds a URL or a Telegram chat id. */
const DESTINATION_HINT: Record<NotificationKind, string> = {
    discord: "https://discord.com/api/webhooks/…",
    slack: "https://hooks.slack.com/services/…",
    telegram: "-1001234567890 or @channelname",
    webhook: "https://hooks.example.com/…",
};

/** A delivery's outcome → the tone its chip carries. */
const DELIVERY_TONE = {
    delivered: "success",
    failed: "danger",
    pending: "warning",
} as const;

/**
 * Create a channel through the edge route, which seals any secret before it is
 * stored. The route's error text is shown as-is: it names the field that was wrong.
 */
const createChannelRequest = async (body: Record<string, unknown>): Promise<{ id: string; signingSecret?: string }> => {
    const response = await fetch("/v1/notification-channels", {
        body: JSON.stringify(body),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as { error?: string; id?: string; signingSecret?: string } | null;

    if (!response.ok || !payload?.id) {
        throw new Error(payload?.error ?? `could not create channel (HTTP ${String(response.status)})`);
    }

    return payload.signingSecret === undefined ? { id: payload.id } : { id: payload.id, signingSecret: payload.signingSecret };
};

/**
 * Cloud "Notifications" — where an org hears about deploys, domains and previews.
 * Owners and admins add channels (Discord, Slack, Telegram or a signed webhook),
 * choose the events each one gets, and send a test. A channel's secret is never
 * shown again after it is created; a webhook's signing key is revealed once.
 */
export const NotificationsSection = ({ organizationId }: { organizationId: OrgId }): ReactElement => {
    const channelState = useQuery(api.notifications.channels, { organizationId });
    const canManage = channelState?.canManage === true;
    const deliveries = useQuery(api.notifications.deliveries, canManage ? { organizationId } : "skip");
    const updateChannel = useMutation(api.notifications.updateChannel);
    const deleteChannel = useMutation(api.notifications.deleteChannel);
    const sendTest = useMutation(api.notifications.sendTest);

    const [name, setName] = useState("");
    const [kind, setKind] = useState<NotificationKind>("discord");
    const [destination, setDestination] = useState("");
    const [botToken, setBotToken] = useState("");
    const [events, setEvents] = useState<NotificationEvent[]>([...NOTIFICATION_EVENTS]);
    const [error, setError] = useState<null | string>(null);
    const [revealed, setRevealed] = useState<null | { name: string; secret: string }>(null);

    const toggleEvent = (event: NotificationEvent): void => {
        setEvents((current) => (current.includes(event) ? current.filter((item) => item !== event) : [...current, event]));
    };

    /** Run a channel action, showing its failure in the list's error line rather than dropping it. */
    const runChannelAction = (action: Promise<unknown>, fallback: string): void => {
        setError(null);
        action.catch((error_: unknown) => {
            setError(error_ instanceof Error ? error_.message : fallback);
        });
    };

    if (channelState && !canManage) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Notifications</CardTitle>
                    <CardDescription>Only owners and admins can see and manage this organization&apos;s notification channels.</CardDescription>
                </CardHeader>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            {revealed ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Signing key for {revealed.name}</CardTitle>
                        <CardDescription>
                            Copy this now; it is not shown again. Verify each delivery with HMAC-SHA256 over <code>timestamp.body</code>, using the{" "}
                            <code>Lunora-Signature</code> header (<code>t=…,v1=…</code>, with Unix seconds).
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex items-center gap-3">
                        <code className="min-w-0 flex-1 truncate font-mono text-sm">{revealed.secret}</code>
                        <Button
                            onClick={() => {
                                setRevealed(null);
                            }}
                            size="sm"
                            type="button"
                            variant="ghost"
                        >
                            Done
                        </Button>
                    </CardContent>
                </Card>
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle>Channels</CardTitle>
                    <CardDescription>Each enabled channel receives the events it subscribes to.</CardDescription>
                </CardHeader>
                <CardContent>
                    <AsyncList
                        empty="No channels yet — add one below to hear about deploys and domains."
                        render={(rows) => (
                            <RowList>
                                {rows.map((channel) => (
                                    <Row key={channel._id}>
                                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                            <span className="truncate font-medium">{channel.name}</span>
                                            <span className={cn(COLUMN_LABEL, "text-muted-foreground truncate")}>
                                                {KIND_LABELS[channel.kind]} {channel.destination}
                                            </span>
                                            <span className="flex flex-wrap gap-1 pt-1">
                                                {channel.events.map((event) => (
                                                    <StatusBadge key={event}>{EVENT_LABELS[event]}</StatusBadge>
                                                ))}
                                            </span>
                                        </span>
                                        <StatusBadge tone={channel.enabled ? "success" : "neutral"}>{channel.enabled ? "on" : "off"}</StatusBadge>
                                        <RowActions>
                                            <Button
                                                onClick={() => {
                                                    runChannelAction(sendTest.mutate({ id: channel._id, organizationId }), "could not send the test");
                                                }}
                                                size="sm"
                                                type="button"
                                                variant="ghost"
                                            >
                                                Send test
                                            </Button>
                                            <Button
                                                onClick={() => {
                                                    runChannelAction(
                                                        updateChannel.mutate({ enabled: !channel.enabled, id: channel._id, organizationId }),
                                                        "could not update the channel",
                                                    );
                                                }}
                                                size="sm"
                                                type="button"
                                                variant="ghost"
                                            >
                                                {channel.enabled ? "Disable" : "Enable"}
                                            </Button>
                                            <Button
                                                className="text-destructive hover:text-destructive"
                                                onClick={() => {
                                                    runChannelAction(deleteChannel.mutate({ id: channel._id, organizationId }), "could not remove the channel");
                                                }}
                                                size="sm"
                                                type="button"
                                                variant="ghost"
                                            >
                                                Remove
                                            </Button>
                                        </RowActions>
                                    </Row>
                                ))}
                            </RowList>
                        )}
                        rows={channelState?.channels}
                    />
                    <FormError message={error} />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>New channel</CardTitle>
                </CardHeader>
                <CardContent>
                    <FieldForm
                        action={() => {
                            setError(null);

                            const run = async (): Promise<void> => {
                                const created = await createChannelRequest({
                                    destination,
                                    events,
                                    kind,
                                    name,
                                    organizationId,
                                    ...(kind === "telegram" ? { secret: botToken } : {}),
                                });

                                if (created.signingSecret !== undefined) {
                                    setRevealed({ name, secret: created.signingSecret });
                                }

                                setName("");
                                setDestination("");
                                setBotToken("");
                            };

                            void run().catch((error_: unknown) => {
                                setError(error_ instanceof Error ? error_.message : "could not create channel");
                            });
                        }}
                        className="max-w-2xl sm:grid-cols-2"
                    >
                        <Field htmlFor="notification-name" label="Channel name">
                            <Input
                                id="notification-name"
                                onChange={(event) => {
                                    setName(event.target.value);
                                }}
                                placeholder="Team chat"
                                required
                                value={name}
                            />
                        </Field>
                        <Field htmlFor="notification-kind" label="Kind">
                            <Select
                                onValueChange={(value: unknown) => {
                                    setKind(value as NotificationKind);
                                }}
                                value={kind}
                            >
                                <SelectTrigger id="notification-kind">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        {NOTIFICATION_KINDS.map((value) => (
                                            <SelectItem key={value} value={value}>
                                                {KIND_LABELS[value]}
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field htmlFor="notification-destination" label={kind === "telegram" ? "Chat id" : "Destination URL"}>
                            <Input
                                id="notification-destination"
                                onChange={(event) => {
                                    setDestination(event.target.value);
                                }}
                                placeholder={DESTINATION_HINT[kind]}
                                required
                                value={destination}
                            />
                        </Field>
                        {kind === "telegram" ? (
                            <Field htmlFor="notification-token" label="Bot token">
                                <Input
                                    autoComplete="off"
                                    id="notification-token"
                                    onChange={(event) => {
                                        setBotToken(event.target.value);
                                    }}
                                    placeholder="123456:ABC…"
                                    required
                                    type="password"
                                    value={botToken}
                                />
                            </Field>
                        ) : null}
                        <fieldset className="grid gap-2 sm:col-span-2">
                            <legend className={COLUMN_LABEL}>Events</legend>
                            {NOTIFICATION_EVENTS.map((event) => (
                                <label className="flex items-center gap-2 text-sm" htmlFor={`notification-event-${event}`} key={event}>
                                    <input
                                        checked={events.includes(event)}
                                        className="size-4 accent-primary"
                                        id={`notification-event-${event}`}
                                        onChange={() => {
                                            toggleEvent(event);
                                        }}
                                        type="checkbox"
                                    />
                                    {EVENT_LABELS[event]}
                                </label>
                            ))}
                        </fieldset>
                        <div className="sm:col-span-2">
                            <Button disabled={events.length === 0} type="submit">
                                Add channel
                            </Button>
                        </div>
                    </FieldForm>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Recent deliveries</CardTitle>
                    <CardDescription>Sent by the every-minute sweep. A row that failed says why, and retries are shown as pending.</CardDescription>
                </CardHeader>
                <CardContent>
                    <AsyncList
                        empty="No deliveries yet."
                        render={(rows) => (
                            <RowList>
                                {rows.map((delivery) => (
                                    <Row key={delivery._id}>
                                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                            <span className="truncate font-medium">{delivery.subject}</span>
                                            <span className={cn(COLUMN_LABEL, "text-muted-foreground truncate")}>
                                                {delivery.channelName} · {formatDateTime(delivery.createdAt)}
                                                {delivery.error ? ` · ${delivery.error}` : ""}
                                            </span>
                                        </span>
                                        <StatusBadge tone={DELIVERY_TONE[delivery.status]}>{delivery.status}</StatusBadge>
                                    </Row>
                                ))}
                            </RowList>
                        )}
                        rows={deliveries}
                    />
                </CardContent>
            </Card>
        </div>
    );
};
