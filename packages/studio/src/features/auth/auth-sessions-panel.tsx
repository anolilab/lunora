import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget, formatTimestamp } from "../../lib/internal";

/** How many sessions to pull for the global browser. */
const SESSION_LIMIT = 200;

/**
 * Global auth-sessions browser — lists live sessions across every user (not
 * scoped to one user like the drawer's `UserSessionsPanel`), each revocable
 * in place. The auth store is HTTP-only (no live subscription channel), so the
 * panel polls via {@link useAutoRefresh} — bumping `version` re-lists — to stay
 * current without a reload button (paused while the tab is hidden).
 */

const AuthSessionsPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();

    // The auth store is HTTP-only (no admin-RPC path), so it's a `useClientQuery`
    // over `client.listAuthSessions`.
    const sessionsQuery = useClientQuery(["lunora-auth-sessions", SESSION_LIMIT], () => client.listAuthSessions({ limit: SESSION_LIMIT }));
    const { error } = sessionsQuery;
    const sessions = sessionsQuery.data?.rows ?? null;

    // No subscription channel, so poll to catch new sessions / revokes without a
    // reload button (paused while the tab is hidden).
    useAutoRefresh(() => {
        sessionsQuery.refetch();
    }, true);

    /** Revoke a session, then refetch so the list reflects the removal. */
    const onRevoke = (sessionId: string): void => {
        fireAndForget(
            (async (): Promise<void> => {
                await client.revokeAuthSession({ sessionId });
                sessionsQuery.refetch();
            })(),
        );
    };

    return (
        <div className="flex flex-col gap-4" data-testid="auth-sessions">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="auth-sessions-error" role="alert">
                    {error}
                </p>
            )}

            {sessions !== null && sessions.length === 0 && <EmptyState testId="auth-sessions-empty" title={t("No active sessions.")} />}

            {sessions !== null && sessions.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="auth-sessions-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("user")}</TableHead>
                                    <TableHead>{t("expires")}</TableHead>
                                    <TableHead>{t("ip")}</TableHead>
                                    <TableHead>{t("user agent")}</TableHead>
                                    <TableHead>{t("impersonated by")}</TableHead>
                                    <TableHead aria-label={t("Actions")} />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {sessions.map((session) => (
                                    <TableRow data-testid={`auth-session-${session.id}`} key={session.id}>
                                        <TableCell className="font-mono text-xs">{session.userId}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(session.expiresAt)}</TableCell>
                                        <TableCell>{session.ipAddress ?? ""}</TableCell>
                                        <TableCell className="max-w-40 truncate">{session.userAgent ?? ""}</TableCell>
                                        <TableCell className="font-mono text-xs">{session.impersonatedBy ?? ""}</TableCell>
                                        <TableCell>
                                            <Button
                                                data-testid={`auth-session-revoke-${session.id}`}
                                                onClick={() => {
                                                    onRevoke(session.id);
                                                }}
                                                size="xs"
                                                type="button"
                                                variant="ghost"
                                            >
                                                {t("Revoke")}
                                            </Button>
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
export default AuthSessionsPanel;
