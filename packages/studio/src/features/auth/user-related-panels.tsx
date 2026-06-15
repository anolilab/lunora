import type { AuthCapabilities, AuthSession } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatCell, formatTimestamp } from "../../lib/internal";

/** Run a mutation through the drawer's shared busy/error model, then bump the version so every related panel refetches. */
type RunAction = (action: () => Promise<void>) => void;

interface RelatedPanelProps {
    readonly busy: boolean;
    /** A shared action runner: sets busy + surfaces errors + refetches related panels on success. */
    readonly runAction: RunAction;
    readonly userId: string;
    /** Bumped after any drawer mutation; panels refetch when it changes. */
    readonly version: number;
}

/** Section heading shared by the related panels. */
const SectionHeading = ({ children }: { readonly children: string }): ReactElement => (
    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>
);

/**
 * The user's live sessions, with a per-row revoke. Revoke goes through the
 * shared `runAction` so the list (and the rest of the drawer) refetch on success.
 */
export const UserSessionsPanel = ({ busy, runAction, userId, version }: RelatedPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [sessions, setSessions] = useState<AuthSession[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    useEffect(() => {
        fireAndForget(
            (async (): Promise<void> => {
                setError(null);

                try {
                    const page = await client.listAuthSessions({ limit: 50, userId });

                    setSessions(page.rows);
                } catch (error_) {
                    setSessions(null);
                    setError(errorMessage(error_));
                }
            })(),
        );
    }, [client, userId, version]);

    const onRevoke = useCallback(
        (sessionId: string): void => {
            runAction(() => client.revokeAuthSession({ sessionId }));
        },
        [client, runAction],
    );

    return (
        <div className="flex flex-col gap-2" data-testid="ud-sessions">
            <SectionHeading>{t("Sessions")}</SectionHeading>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="ud-sessions-error" role="alert">
                    {error}
                </p>
            )}

            {sessions !== null && sessions.length === 0 && (
                <p className="text-sm text-muted-foreground" data-testid="ud-sessions-empty">
                    {t("No active sessions.")}
                </p>
            )}

            {sessions !== null && sessions.length > 0 && (
                <div className="rounded-md border border-border">
                    <Table data-testid="ud-sessions-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("expires")}</TableHead>
                                <TableHead>{t("ip")}</TableHead>
                                <TableHead>{t("user agent")}</TableHead>
                                <TableHead aria-label={t("Actions")} />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {sessions.map((session) => (
                                <TableRow data-testid={`ud-session-${session.id}`} key={session.id}>
                                    <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(session.expiresAt)}</TableCell>
                                    <TableCell>{session.ipAddress ?? ""}</TableCell>
                                    <TableCell className="max-w-40 truncate">{session.userAgent ?? ""}</TableCell>
                                    <TableCell>
                                        <Button
                                            data-testid={`ud-revoke-${session.id}`}
                                            disabled={busy}
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

/** The user's linked accounts (credential / OAuth providers), each unlinkable. Gated on `capabilities.accounts`. */
export const UserAccountsPanel = ({ busy, runAction, userId, version }: RelatedPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [accounts, setAccounts] = useState<Record<string, unknown>[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    useEffect(() => {
        fireAndForget(
            (async (): Promise<void> => {
                setError(null);

                try {
                    setAccounts(await client.listAuthAccounts({ userId }));
                } catch (error_) {
                    setAccounts(null);
                    setError(errorMessage(error_));
                }
            })(),
        );
    }, [client, userId, version]);

    const onUnlink = useCallback(
        (accountId: string): void => {
            runAction(() => client.unlinkAuthAccount({ accountId, userId }));
        },
        [client, runAction, userId],
    );

    return (
        <div className="flex flex-col gap-2" data-testid="ud-accounts">
            <SectionHeading>{t("Linked accounts")}</SectionHeading>

            {error !== null && (
                <p className="text-sm text-destructive" role="alert">
                    {error}
                </p>
            )}

            {accounts !== null && accounts.length === 0 && <p className="text-sm text-muted-foreground">{t("No linked accounts.")}</p>}

            {accounts !== null && accounts.length > 0 && (
                <div className="rounded-md border border-border">
                    <Table data-testid="ud-accounts-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("provider")}</TableHead>
                                <TableHead>{t("created")}</TableHead>
                                <TableHead aria-label={t("Actions")} />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {accounts.map((account) => {
                                const id = formatCell(account["id"]);

                                return (
                                    <TableRow data-testid={`ud-account-${id}`} key={id}>
                                        <TableCell>{formatCell(account["providerId"])}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(account["createdAt"] as number)}</TableCell>
                                        <TableCell>
                                            <Button
                                                data-testid={`ud-unlink-${id}`}
                                                disabled={busy}
                                                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler; admin dev-tool path
                                                onClick={() => {
                                                    onUnlink(id);
                                                }}
                                                size="xs"
                                                type="button"
                                                variant="ghost"
                                            >
                                                {t("Unlink")}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
};

/** Security factors: 2FA status/disable and registered passkeys, each gated on its plugin capability. */
export const UserSecurityPanel = ({
    busy,
    capabilities,
    runAction,
    userId,
    version,
}: RelatedPanelProps & { readonly capabilities: AuthCapabilities }): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [passkeys, setPasskeys] = useState<Record<string, unknown>[] | null>(null);

    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- capability-gated data load: fetch the user's passkeys when the `capabilities.passkey` prop is enabled, re-running on userId/version (refetch token); async fetch, not derivable during render and not a user event
        if (!capabilities.passkey) {
            return;
        }

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    setPasskeys(await client.listAuthPasskeys({ userId }));
                } catch {
                    setPasskeys(null);
                }
            })(),
        );
    }, [capabilities.passkey, client, userId, version]);

    const onDisable2fa = useCallback((): void => {
        runAction(() => client.disableAuthTwoFactor({ userId }));
    }, [client, runAction, userId]);

    const onDeletePasskey = useCallback(
        (passkeyId: string): void => {
            runAction(() => client.deleteAuthPasskey({ passkeyId }));
        },
        [client, runAction],
    );

    return (
        <div className="flex flex-col gap-2" data-testid="ud-security">
            <SectionHeading>{t("Security")}</SectionHeading>

            {capabilities.twoFactor && (
                <Button data-testid="ud-disable-2fa" disabled={busy} onClick={onDisable2fa} size="sm" type="button" variant="outline">
                    {t("Disable two-factor")}
                </Button>
            )}

            {capabilities.passkey && passkeys !== null && passkeys.length === 0 && <p className="text-sm text-muted-foreground">{t("No passkeys.")}</p>}

            {capabilities.passkey && passkeys !== null && passkeys.length > 0 && (
                <div className="rounded-md border border-border">
                    <Table data-testid="ud-passkeys-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("name")}</TableHead>
                                <TableHead>{t("created")}</TableHead>
                                <TableHead aria-label={t("Actions")} />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {passkeys.map((passkey) => {
                                const id = formatCell(passkey["id"]);

                                return (
                                    <TableRow data-testid={`ud-passkey-${id}`} key={id}>
                                        <TableCell>{formatCell(passkey["name"]) || id}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(passkey["createdAt"] as number)}</TableCell>
                                        <TableCell>
                                            <Button
                                                data-testid={`ud-delete-passkey-${id}`}
                                                disabled={busy}
                                                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler; admin dev-tool path
                                                onClick={() => {
                                                    onDeletePasskey(id);
                                                }}
                                                size="xs"
                                                type="button"
                                                variant="ghost"
                                            >
                                                {t("Delete")}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
};

export type { RelatedPanelProps, RunAction };
