import type { ChangeEvent, ReactElement } from "react";
import { useState } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { PushSubscriptionDevice, PushSubscriptionsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";

/** The three kind filters the toolbar toggles between (`"all"` clears the filter). */
type KindFilter = "all" | "fcm" | "web-push";

/** Map a device's last-send status to a semantic badge variant. */
const statusVariant = (status: string | undefined): "destructive" | "secondary" | "success" | "warning" => {
    if (status === "ok") {
        return "success";
    }

    if (status === "failed") {
        return "destructive";
    }

    if (status === "expired") {
        return "warning";
    }

    return "secondary";
};

/**
 * A device's human-readable target: the Web Push service endpoint (web-push) or,
 * lacking one (FCM), the stable id. The delivery secrets (Web Push `keys`, FCM
 * `token`) are stripped server-side, so a device is only ever identified by its
 * endpoint / id here — never by a credential.
 */
const deviceTarget = (device: PushSubscriptionDevice): string => device.endpoint ?? device.id;

/**
 * The Notifications inspector — the app's registered `@lunora/notify` push
 * devices, read through the gated `__lunora_admin__:listPushSubscriptions` admin
 * RPC (`useAdminQuery`; gated by the server's `LUNORA_ADMIN_TOKEN`). Each row is
 * one registered device: its delivery kind, target endpoint, owning user, last
 * register/send touch, and the last-send status + any delivery error.
 *
 * The subscription store is a WORKER option (built from `env` via
 * `defineNotify({ store })`), not shard state, so this is a one-shot read with a
 * manual Refresh — there is no DO write-flush to subscribe to. When the app wires
 * no `@lunora/notify` store (or none yet registered), the RPC returns an empty
 * device list and the panel shows an empty state rather than erroring.
 */
const NotificationsPanel = (): ReactElement => {
    const t = useT();

    const [kind, setKind] = useState<KindFilter>("all");
    const [search, setSearch] = useState<string>("");

    // One-shot admin read (no shard, no live subscription): the store is a worker
    // option, so there is no per-shard write-flush to stream. `refetch` backs the
    // manual Refresh button.
    const { data, error, errorSource, isLoading, refetch } = useAdminQuery<PushSubscriptionsResult>(ADMIN_FUNCTIONS.listPushSubscriptions, {});

    const devices: PushSubscriptionDevice[] = data?.subscriptions ?? [];

    // Client-side kind + substring filter over the already-fetched devices — never
    // triggers a refetch. The substring matches the target endpoint/id and owner.
    // (React Compiler memoizes this derivation — no useMemo.)
    const needle = search.trim().toLowerCase();
    const filtered: PushSubscriptionDevice[] = devices.filter((device) => {
        if (kind !== "all" && device.kind !== kind) {
            return false;
        }

        if (needle === "") {
            return true;
        }

        return `${deviceTarget(device)} ${device.userId ?? ""}`.toLowerCase().includes(needle);
    });

    const onSearchChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    };

    const onRefresh = (): void => {
        refetch();
    };

    const kinds: ReadonlyArray<KindFilter> = ["all", "web-push", "fcm"];

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-notifications">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1" data-testid="nt-kind-filter" role="tablist">
                    {kinds.map((value) => (
                        <Button
                            aria-selected={kind === value}
                            data-testid={`nt-kind-${value}`}
                            key={value}
                            onClick={(): void => {
                                setKind(value);
                            }}
                            role="tab"
                            size="sm"
                            type="button"
                            variant={kind === value ? "secondary" : "ghost"}
                        >
                            {value === "all" ? t("All") : value}
                        </Button>
                    ))}
                </div>
                <Input
                    aria-label={t("Filter devices")}
                    className="h-8 w-56"
                    data-testid="nt-search"
                    onChange={onSearchChange}
                    placeholder={t("filter endpoint, user")}
                    value={search}
                />
                <Button className="ml-auto" data-testid="nt-refresh" onClick={onRefresh} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                {devices.length > 0 && (
                    <Badge data-testid="nt-count" variant="secondary">
                        {t("{count} devices", { count: devices.length })}
                    </Badge>
                )}
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="nt-error" />}

            {error === null && !isLoading && filtered.length === 0 && (
                <EmptyState
                    description={t(
                        "Registered Web Push / FCM devices appear here. Configure lunora/notify.ts with defineNotify({ store }) and register a device with ctx.push.register(...).",
                    )}
                    icon={
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-4-5.7V5a2 2 0 1 0-4 0v.3A6 6 0 0 0 6 11v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
                        </svg>
                    }
                    testId="nt-empty"
                    title={t("No registered devices.")}
                />
            )}

            {filtered.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="max-h-[30rem] overflow-auto px-0">
                        <Table data-testid="nt-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("kind")}</TableHead>
                                    <TableHead>{t("endpoint")}</TableHead>
                                    <TableHead>{t("user")}</TableHead>
                                    <TableHead>{t("last seen")}</TableHead>
                                    <TableHead>{t("status")}</TableHead>
                                    <TableHead>{t("error")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map((device) => {
                                    const target = deviceTarget(device);

                                    return (
                                        <TableRow data-testid="nt-row" key={device.id}>
                                            <TableCell>
                                                <Badge variant="outline">{device.kind}</Badge>
                                            </TableCell>
                                            <TableCell className="max-w-[28ch] truncate font-mono text-xs" title={target}>
                                                {target}
                                            </TableCell>
                                            <TableCell className="max-w-[16ch] truncate font-mono text-xs">
                                                {device.userId ?? <span className="text-muted-foreground">—</span>}
                                            </TableCell>
                                            <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(device.lastSeenAt, "—")}</TableCell>
                                            <TableCell>
                                                <Badge data-testid={`nt-status-${device.id}`} variant={statusVariant(device.lastStatus)}>
                                                    {device.lastStatus ?? t("n/a")}
                                                </Badge>
                                            </TableCell>
                                            <TableCell
                                                className="max-w-[28ch] truncate font-mono text-xs text-muted-foreground"
                                                title={device.lastError ?? undefined}
                                            >
                                                {device.lastError ?? <span className="text-muted-foreground">—</span>}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export { NotificationsPanel };
