import type { ChangeEvent, ReactElement } from "react";
import { useMemo, useState } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { AuthAuditEntry, AuthAuditLogResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";

/**
 * Security / audit — the authentication & security event trail (sign-in, sign-up,
 * password change, MFA toggle, token refresh, session revoke, account link/unlink),
 * newest first. Reads via the `__lunora_admin__:getAuthAuditLog` RPC through
 * {@link useAdminQuery}; gated by the server's `LUNORA_ADMIN_TOKEN`.
 *
 * Distinct from the admin-op audit log (`features/logs/audit-panel.tsx`): that
 * records state-changing ADMIN operations per shard (DO SQLite); this records
 * AUTH events for compliance/forensics, stored in the auth D1 database, so it is
 * not shard-scoped and has no live subscription channel — a one-shot read with a
 * Refresh button. The event/actor/IP filter is client-side over the fetched
 * buffer and never triggers a refetch.
 */
const AuthAuditPanel = (): ReactElement => {
    const t = useT();

    const [search, setSearch] = useState<string>("");

    // One-shot admin read of the auth audit trail. The auth store is D1-backed and
    // HTTP-only (no per-shard WS), so unlike the admin-op audit panel this isn't
    // `live` — Refresh re-runs the read.
    const { data, error, errorSource, isLoading, refetch } = useAdminQuery<AuthAuditLogResult>(ADMIN_FUNCTIONS.getAuthAuditLog, {});

    const entries = useMemo<AuthAuditEntry[]>(() => data?.entries ?? [], [data]);

    // Client-side substring filter (case-insensitive) over the already-fetched
    // entries — matching event type, actor id/email, IP, and outcome. Never
    // triggers a refetch.
    const filtered = useMemo<AuthAuditEntry[]>(() => {
        const needle = search.trim().toLowerCase();

        if (needle === "") {
            return entries;
        }

        return entries.filter(
            (entry) =>
                entry.event.toLowerCase().includes(needle) ||
                (entry.actorId ?? "").toLowerCase().includes(needle) ||
                (entry.actorEmail ?? "").toLowerCase().includes(needle) ||
                (entry.ip ?? "").toLowerCase().includes(needle) ||
                entry.outcome.toLowerCase().includes(needle),
        );
    }, [entries, search]);

    const onSearchChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-auth-audit">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label={t("Filter security events")}
                    className="h-8 w-56"
                    data-testid="aa-search"
                    onChange={onSearchChange}
                    placeholder={t("filter event, actor, IP")}
                    value={search}
                />
                <Button
                    data-testid="aa-refresh"
                    onClick={() => {
                        refetch();
                    }}
                    size="xs"
                    type="button"
                    variant="ghost"
                >
                    {t("Refresh")}
                </Button>
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="aa-error" />}

            {error === null && !isLoading && filtered.length === 0 && (
                <EmptyState description={t("Authentication and security events are recorded here.")} testId="aa-empty" title={t("No security events.")} />
            )}

            {filtered.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="max-h-[30rem] overflow-auto px-0">
                        <Table data-testid="aa-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("time")}</TableHead>
                                    <TableHead>{t("event")}</TableHead>
                                    <TableHead>{t("actor")}</TableHead>
                                    <TableHead>{t("ip / user agent")}</TableHead>
                                    <TableHead>{t("outcome")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map((entry) => (
                                    <TableRow data-testid="aa-row" key={entry.seq}>
                                        <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(entry.ts, "—")}</TableCell>
                                        <TableCell>
                                            <Badge variant="secondary">{entry.event}</Badge>
                                        </TableCell>
                                        <TableCell className="max-w-[24ch] truncate font-mono text-xs" title={entry.actorId ?? undefined}>
                                            {entry.actorEmail ?? entry.actorId ?? <span className="text-muted-foreground">—</span>}
                                        </TableCell>
                                        <TableCell className="max-w-[28ch] truncate text-xs text-muted-foreground" title={entry.userAgent ?? undefined}>
                                            {entry.ip ?? <span className="text-muted-foreground">—</span>}
                                            {entry.userAgent !== undefined && <span className="ml-1 opacity-70">· {entry.userAgent}</span>}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={entry.outcome === "failure" ? "destructive" : "outline"}>{t(entry.outcome)}</Badge>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export { AuthAuditPanel };
