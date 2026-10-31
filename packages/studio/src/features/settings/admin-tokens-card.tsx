import type { AdminTokenSummary, CreatedAdminToken } from "@lunora/client";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import useStudioClient from "../../hooks/use-studio-client";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

const DAY_MS = 86_400_000;

/**
 * Named admin tokens: create (the secret is shown once), list, revoke. The
 * routes are root-only, so a Studio signed in with a named token sees the
 * refusal here rather than a list.
 */
const AdminTokensCard = (): ReactElement => {
    const client = useStudioClient();
    const t = useT();

    // Tagged with the client that listed them: a swapped deployment or credential must not show its
    // predecessor's tokens while its own list is pending or has failed.
    const [listed, setListed] = useState<{ owner: typeof client; tokens: AdminTokenSummary[] }>({ owner: client, tokens: [] });
    const tokens = listed.owner === client ? listed.tokens : [];
    const [error, setError] = useState<null | string>(null);
    // The one-time secret, tagged with the client that minted it: it is shown only while that client is
    // current, and dropped the render after the credentials or deployment change.
    const [issued, setIssued] = useState<{ owner: typeof client; token: CreatedAdminToken } | null>(null);

    if (issued !== null && issued.owner !== client) {
        setIssued(null);
    }

    const created = issued?.owner === client ? issued.token : null;
    const [name, setName] = useState("");
    const [days, setDays] = useState("");
    // Which client has a create in flight, so one client's slow request never holds up the next.
    const [creatingFor, setCreatingFor] = useState<typeof client | null>(null);
    const creating = creatingFor === client;
    // Only the newest list answer is applied: the mount-time load can land after
    // a create or revoke reload and would otherwise show a stale list.
    const listRequest = useRef(0);
    // The client as of the latest render, for answers that arrive after it changed.
    const latestClient = useRef(client);

    useEffect(() => {
        latestClient.current = client;
    }, [client]);

    const reload = useCallback(async (): Promise<void> => {
        // A reload for a client that is no longer current must not start: its request counter would
        // supersede the current client's own list, and its answer would be hidden by the owner check.
        if (latestClient.current !== client) {
            return;
        }

        listRequest.current += 1;

        const request = listRequest.current;

        try {
            const fetched = await client.listAdminTokens();

            if (request === listRequest.current) {
                setListed({ owner: client, tokens: fetched });
                setError(null);
            }
        } catch (error_) {
            if (request === listRequest.current) {
                setError(errorMessage(error_));
            }
        }
    }, [client]);

    useEffect(() => {
        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- the state is set after the awaited list request, the effect subscribing to an external fetch; the newest-request guard drops a stale answer
        fireAndForget(reload());
    }, [reload]);

    // Structurally typed: `React.FormEvent` is flagged deprecated, and only `preventDefault` is read.
    const onCreate = (event: { preventDefault: () => void }): void => {
        event.preventDefault();

        // A second submit while one is in flight, or while a secret is still on screen, would
        // mint a token whose secret is never shown or replace one the operator has not copied.
        if (creating || created !== null) {
            return;
        }

        setCreatingFor(client);

        const owner = client;
        const expiresAt = days === "" ? undefined : Date.now() + Number(days) * DAY_MS;

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const minted = await owner.createAdminToken({ expiresAt, name: name.trim() });

                    // A result for a client that is no longer current is not shown, and not reloaded.
                    if (latestClient.current === owner) {
                        setIssued({ owner, token: minted });
                        setName("");
                        setDays("");
                        await reload();
                    }
                } catch (error_) {
                    setError(errorMessage(error_));
                }

                // After the try rather than in a `finally`: the catch never rethrows, and the compiler cannot optimize a `finally`.
                setCreatingFor((current) => (current === owner ? null : current));
            })(),
        );
    };

    const revoke = (target: string): void => {
        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await client.revokeAdminToken(target);
                    setIssued((current) => (current?.token.name === target ? null : current));
                    await reload();
                } catch (error_) {
                    // The revocation is recorded before the token row is deleted, so a failure after
                    // that point leaves a token that is refused but still listed: show what is real,
                    // then report the failure.
                    await reload();

                    if (latestClient.current === client) {
                        setError(errorMessage(error_));
                    }
                }
            })(),
        );
    };

    return (
        <Card className="py-0" data-testid="set-admin-tokens">
            <header className="border-b border-border px-4 py-3">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Admin tokens")}</span>
            </header>
            <CardContent className="flex flex-col gap-3 py-3">
                <p className="text-xs text-muted-foreground">
                    {t("Named tokens use the admin API but cannot manage tokens or open admin WebSockets. A revoked token is refused within 30 seconds.")}
                </p>

                {error !== null && (
                    <p className="text-sm text-destructive" data-testid="set-admin-tokens-error" role="alert">
                        {error}
                    </p>
                )}

                {created !== null && (
                    <div className="rounded-md border border-border p-3 text-xs" data-testid="set-admin-token-created" role="status">
                        <p className="pb-1 text-muted-foreground">{t("Copy this token now. It is not shown again.")}</p>
                        <code className="font-mono break-all select-all">{created.token}</code>
                        <div className="pt-2">
                            <Button
                                data-testid="set-admin-token-dismiss"
                                onClick={() => {
                                    setIssued(null);
                                }}
                                size="xs"
                                variant="outline"
                            >
                                {t("Dismiss")}
                            </Button>
                        </div>
                    </div>
                )}

                <form className="flex flex-wrap items-end gap-2" onSubmit={onCreate}>
                    <Input
                        aria-label={t("Token name")}
                        className="w-48"
                        data-testid="set-admin-token-name"
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                        pattern="[a-z0-9][a-z0-9_\-]{0,63}"
                        placeholder="ci-deploy"
                        required
                        value={name}
                    />
                    <Input
                        aria-label={t("Expires in days (optional)")}
                        className="w-40"
                        min={1}
                        onChange={(event) => {
                            setDays(event.target.value);
                        }}
                        placeholder={t("Expires in days (optional)")}
                        type="number"
                        value={days}
                    />
                    <Button data-testid="set-admin-token-create" disabled={creating || created !== null} size="sm" type="submit">
                        {t("Create token")}
                    </Button>
                </form>

                {tokens.length > 0 && (
                    <Table data-testid="set-admin-tokens-table">
                        {/* react-doctor-disable-next-line react-doctor/duplicate-jsx-subtree -- the resemblance to the other settings tables is incidental; their columns and actions differ */}
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("name")}</TableHead>
                                <TableHead>{t("Created")}</TableHead>
                                <TableHead>{t("Last used")}</TableHead>
                                <TableHead>{t("Expires")}</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {tokens.map((token) => (
                                <TableRow data-testid="set-admin-token-row" key={token.name}>
                                    <TableCell className="font-mono text-xs">
                                        {token.name}
                                        {/* Refused already; the row only still holds the name until a revoke clears it. */}
                                        {token.revoked === true && <span className="pl-2 text-destructive">{t("Revoked")}</span>}
                                    </TableCell>
                                    <TableCell className="text-xs">{formatTimestamp(token.createdAt)}</TableCell>
                                    <TableCell className="text-xs">{formatTimestamp(token.lastUsedAt, "—")}</TableCell>
                                    <TableCell className="text-xs">{formatTimestamp(token.expiresAt, t("Never"))}</TableCell>
                                    <TableCell>
                                        {/* A revoke cannot be undone and the secret is not shown again, so it takes a second click. */}
                                        <ConfirmButton
                                            onConfirm={() => {
                                                revoke(token.name);
                                            }}
                                            testId={`set-admin-token-revoke-${token.name}`}
                                        >
                                            {t("Revoke")}
                                        </ConfirmButton>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
};

export default AdminTokensCard;
