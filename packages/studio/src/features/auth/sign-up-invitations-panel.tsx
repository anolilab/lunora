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
import { fireAndForget, formatTimestamp, workerBaseUrl } from "../../lib/internal";
import type { InvitationRow } from "./invitation-status";
import { invitationStatus } from "./invitation-status";

/** How many invitations to pull — the admin plane's own ceiling, so this asks for everything it will give. */
const INVITATION_LIMIT = 500;

/**
 * The link the invitee opens: `signUpPage` with `email` + `invite` set, keeping
 * any query the page already carries.
 * @returns the link, or `null` while `signUpPage` is not an absolute URL
 */
const invitationLink = (signUpPage: string, issued: { email: string; token: string }): null | string => {
    if (!URL.canParse(signUpPage.trim())) {
        return null;
    }

    const url = new URL(signUpPage.trim());

    url.searchParams.set("email", issued.email);
    url.searchParams.set("invite", issued.token);

    return url.toString();
};

/**
 * The one-time link for a just-issued invitation, with the sign-up page it
 * points at editable in place. Keyed on the token by the parent, so a new
 * invitation starts un-copied.
 */
const IssuedInvitation = ({
    issued,
    onSignUpPageChange,
    signUpPage,
}: {
    readonly issued: { email: string; token: string };
    readonly onSignUpPageChange: (page: string) => void;
    readonly signUpPage: string;
}): ReactElement => {
    const t = useT();
    // The link that was copied, not a flag: an edit to the page while a copy is
    // in flight must not leave "Copied" showing for a link that was never copied.
    const [copiedLink, setCopiedLink] = useState<null | string>(null);
    const link = invitationLink(signUpPage, issued);

    const onCopyLink = (): void => {
        // Mirrors `apply-index-button.tsx`: a studio served over a LAN IP is not a
        // secure context, so `navigator.clipboard` is undefined there, and even
        // where it exists the write can be denied. `copiedLink` is therefore only set
        // in the success branch — the link stays selectable in the field either
        // way, and claiming a copy that did not happen is how an operator loses a
        // token they cannot get back.
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard; guarded by the "navigator" in globalThis check
        const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

        if (link === null || clipboard === undefined) {
            return;
        }

        fireAndForget(
            clipboard.writeText(link).then((): boolean => {
                setCopiedLink(link);

                return true;
            }),
        );
    };

    return (
        <Card>
            <CardContent className="flex flex-col gap-2 p-4">
                <p className="text-sm">{t("Send this link to the invitee. It is shown once and cannot be recovered.")}</p>
                <Input
                    aria-invalid={link === null}
                    aria-label={t("Your app's sign-up page")}
                    data-testid="sign-up-invitation-page"
                    onChange={(event) => {
                        onSignUpPageChange(event.target.value);
                    }}
                    value={signUpPage}
                />
                <div className="flex gap-2">
                    <Input data-testid="sign-up-invitation-link" readOnly value={link ?? ""} />
                    <Button data-testid="sign-up-invitation-copy" onClick={onCopyLink} type="button">
                        {copiedLink !== null && copiedLink === link ? t("Copied") : t("Copy")}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
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
    const [issued, setIssued] = useState<null | { email: string; token: string }>(null);
    // Where the invitee signs up. The page belongs to the APP, which the studio
    // cannot see — so it defaults to the auth UI's `sign-up` route on the worker
    // origin the studio talks to (not the studio's own origin, which is a
    // different host whenever the studio is served separately), and the operator
    // can correct it before copying. Kept here so a correction survives the next invite.
    const [signUpPage, setSignUpPage] = useState(() => `${workerBaseUrl(client.url)}/sign-up`);

    const invitationsQuery = useClientQuery(["lunora-auth-sign-up-invitations", INVITATION_LIMIT], () =>
        client.listAuthSignUpInvitations({ limit: INVITATION_LIMIT }),
    );

    const rows = (invitationsQuery.data?.rows ?? null) as InvitationRow[] | null;
    const total = invitationsQuery.data?.total ?? 0;

    const onInvite = (): void => {
        const address = email.trim();

        if (address === "") {
            return;
        }

        setError(null);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const created = await client.createAuthSignUpInvitation({ email: address });
                    const token = typeof created["token"] === "string" ? created["token"] : undefined;

                    setIssued(token === undefined ? null : { email: address, token });
                    setEmail("");
                    invitationsQuery.refetch();
                } catch (error_) {
                    setError(error_ instanceof Error ? error_.message : String(error_));
                }
            })(),
        );
    };

    const onRevoke = (address: string): void => {
        setError(null);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await client.revokeAuthSignUpInvitation({ email: address });
                    invitationsQuery.refetch();
                } catch (error_) {
                    // Without this the row simply stays put and the operator is left
                    // to guess whether the click registered.
                    setError(error_ instanceof Error ? error_.message : String(error_));
                }
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

            {issued !== null && <IssuedInvitation issued={issued} key={issued.token} onSignUpPageChange={setSignUpPage} signUpPage={signUpPage} />}

            {(error ?? invitationsQuery.error) !== null && (
                <p className="text-sm text-destructive" data-testid="sign-up-invitations-error" role="alert">
                    {error ?? invitationsQuery.error}
                </p>
            )}

            {rows !== null && rows.length === 0 && <EmptyState testId="sign-up-invitations-empty" title={t("Nobody has been invited yet.")} />}

            {rows !== null && total > rows.length && (
                <p className="text-sm text-muted-foreground" data-testid="sign-up-invitations-truncated">
                    {t("Showing the most recent invitations. Query the signUpInvitation table directly to see the rest.")}
                </p>
            )}

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
                                    const status = invitationStatus(row, Date.now());
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
