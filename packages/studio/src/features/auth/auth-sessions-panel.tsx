import type { AuthSession } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

/** How many sessions to pull for the global browser. */
const SESSION_LIMIT = 200;

/**
 * Global auth-sessions browser — lists live sessions across every user (not
 * scoped to one user like the drawer's `UserSessionsPanel`), each revocable
 * in place. The auth store is HTTP-only (no live subscription channel), so the
 * panel polls via {@link useAutoRefresh} — bumping `version` re-lists — to stay
 * current without a reload button (paused while the tab is hidden).
 */
// eslint-disable-next-line import/prefer-default-export -- studio panels are named exports, mounted by name in studio.tsx
export const AuthSessionsPanel = (): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [sessions, setSessions] = useState<AuthSession[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [version, setVersion] = useState<number>(0);

    useEffect(() => {
        fireAndForget(
            (async (): Promise<void> => {
                setError(null);

                try {
                    const page = await client.listAuthSessions({ limit: SESSION_LIMIT });

                    setSessions(page.rows);
                } catch (error_) {
                    setSessions(null);
                    setError(errorMessage(error_));
                }
            })(),
        );
        // `version` is included so a poll tick (or a revoke) re-lists sessions too.
    }, [client, version]);

    useAutoRefresh(() => {
        setVersion((value) => value + 1);
    }, true);

    /** Revoke a session, surface any error, and bump `version` so the list refetches. */
    const onRevoke = useCallback(
        (sessionId: string): void => {
            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        await client.revokeAuthSession({ sessionId });
                        setVersion((value) => value + 1);
                    } catch (error_) {
                        setError(errorMessage(error_));
                    }
                })(),
            );
        },
        [client],
    );

    return (
        <div className="flex flex-col gap-4" data-testid="auth-sessions">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="auth-sessions-error" role="alert">
                    {error}
                </p>
            )}

            {sessions !== null && sessions.length === 0 && <EmptyState testId="auth-sessions-empty" title={t("No active sessions.")} />}

            {sessions !== null && sessions.length > 0 && (
                <div className="rounded-md border border-border">
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
                                            // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler closes over session.id; admin dev-tool path
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
                </div>
            )}
        </div>
    );
};
