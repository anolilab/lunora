import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget, formatTimestamp } from "../../lib/internal";

/** How many invitations to pull. The admin plane caps a page at 500 regardless. */
const INVITATION_LIMIT = 200;

/** One invitation row as the admin plane returns it — timestamps are epoch-ms. */
interface InvitationRow {
    acceptedAt?: null | number;
    createdAt?: null | number;
    email?: null | string;
    expiresAt?: null | number;
    id: string;
    invitedBy?: null | string;
}

/**
 * The three states a row can be in. Derived here rather than asked of the
 * server: "pending" is `acceptedAt === null && expiresAt > now`, and filtering
 * that server-side after a page would let page 1 come back empty while pending
 * invitations sat on page 2.
 */
const statusOf = (row: InvitationRow): "expired" | "pending" | "spent" => {
    if (typeof row.acceptedAt === "number") {
        return "spent";
    }

    return typeof row.expiresAt === "number" && row.expiresAt <= Date.now() ? "expired" : "pending";
};

/**
 * Sign-up invitations — the operator surface for the `inviteOnly` plugin, which
 * refuses to create an account for an address nobody invited. Rendered inside the
 * Users page (an invitation is who may *become* a user) and only when
 * `capabilities.inviteOnly` says the plugin is installed.
 *
 * Inviting does not send anything: `@lunora/auth` deliberately leaves delivery to
 * the app, so this hands back the address and the operator sends the link. That
 * is stated in the panel rather than left for someone to discover by watching an
 * invitee never receive mail.
 */
const SignUpInvitationsPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();
    const [email, setEmail] = useState("");
    const [error, setError] = useState<null | string>(null);
    // The plaintext token exists for exactly one response. Held in state so the
    // operator can copy the link, and never re-fetchable — the server keeps only
    // a hash.
    const [issuedLink, setIssuedLink] = useState<null | string>(null);

    const invitationsQuery = useClientQuery(["lunora-auth-sign-up-invitations", INVITATION_LIMIT], () =>
        client.listAuthSignUpInvitations({ limit: INVITATION_LIMIT }),
    );

    const rows = (invitationsQuery.data?.rows ?? null) as InvitationRow[] | null;

    const onInvite = (): void => {
        const address = email.trim();

        if (address === "") {
            return;
        }

        setError(null);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const issued = await client.createAuthSignUpInvitation({ email: address });
                    const token = typeof issued["token"] === "string" ? issued["token"] : undefined;

                    setIssuedLink(
                        token === undefined
                            ? null
                            : `${globalThis.location.origin}/sign-up?email=${encodeURIComponent(address)}&invite=${encodeURIComponent(token)}`,
                    );
                    setEmail("");
                    invitationsQuery.refetch();
                } catch (error_) {
                    setError(error_ instanceof Error ? error_.message : String(error_));
                }
            })(),
        );
    };

    const onCopyLink = (): void => {
        if (issuedLink !== null) {
            fireAndForget(globalThis.navigator.clipboard.writeText(issuedLink));
        }
    };

    const onRevoke = (address: string): void => {
        fireAndForget(
            (async (): Promise<void> => {
                await client.revokeAuthSignUpInvitation({ email: address });
                invitationsQuery.refetch();
            })(),
        );
    };

    return (
        <div className="flex flex-col gap-4" data-testid="sign-up-invitations">
            <div>
                <h2 className="text-base font-medium">{t("Sign-up invitations")}</h2>
                <p className="text-sm text-muted-foreground">
                    {t("Only invited addresses can create an account. Nothing is emailed — send the invitee the one-time link yourself.")}
                </p>
            </div>

            <div className="flex gap-2">
                <Input
                    aria-label={t("Email address to invite")}
                    data-testid="sign-up-invitation-email"
                    onChange={(event) => {
                        setEmail(event.target.value);
                    }}
                    placeholder={t("ada@example.com")}
                    type="email"
                    value={email}
                />
                <Button data-testid="sign-up-invitation-submit" onClick={onInvite} type="button">
                    {t("Invite")}
                </Button>
            </div>

            {issuedLink !== null && (
                <Card>
                    <CardContent className="flex flex-col gap-2 p-4">
                        <p className="text-sm">{t("Send this link to the invitee. It is shown once and cannot be recovered.")}</p>
                        <div className="flex gap-2">
                            <Input data-testid="sign-up-invitation-link" readOnly value={issuedLink} />
                            <Button data-testid="sign-up-invitation-copy" onClick={onCopyLink} type="button">
                                {t("Copy")}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {(error ?? invitationsQuery.error) !== null && (
                <p className="text-sm text-destructive" data-testid="sign-up-invitations-error" role="alert">
                    {error ?? invitationsQuery.error}
                </p>
            )}

            {rows !== null && rows.length === 0 && <EmptyState testId="sign-up-invitations-empty" title={t("Nobody has been invited yet.")} />}

            {rows !== null && rows.length > 0 && (
                <Card>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Email")}</TableHead>
                                    <TableHead>{t("Status")}</TableHead>
                                    <TableHead>{t("Expires")}</TableHead>
                                    <TableHead>{t("Invited by")}</TableHead>
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row) => {
                                    const status = statusOf(row);
                                    const address = row.email ?? "";

                                    return (
                                        <TableRow data-testid={`sign-up-invitation-${address}`} key={row.id}>
                                            <TableCell>{address}</TableCell>
                                            <TableCell data-testid={`sign-up-invitation-status-${address}`}>
                                                {status === "spent" && t("Accepted")}
                                                {status === "expired" && t("Expired")}
                                                {status === "pending" && t("Pending")}
                                            </TableCell>
                                            <TableCell>{typeof row.expiresAt === "number" ? formatTimestamp(row.expiresAt) : "—"}</TableCell>
                                            <TableCell>{row.invitedBy ?? "—"}</TableCell>
                                            <TableCell className="text-right">
                                                <Button
                                                    onClick={() => {
                                                        onRevoke(address);
                                                    }}
                                                    type="button"
                                                    variant="ghost"
                                                >
                                                    {t("Revoke")}
                                                </Button>
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

export default SignUpInvitationsPanel;
