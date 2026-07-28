import type { ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { formatDate } from "./format";
import { COLUMN_LABEL, Field, FieldForm, FormError, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";

/** Invitation lifecycle → the tone its status chip carries. */
const INVITATION_TONE = {
    accepted: "success",
    pending: "warning",
    revoked: "neutral",
} as const;

/**
 * Invitations tab. Inviting POSTs to the control plane's `/v1/invitations/send`
 * edge route, which runs `invitations.invite` under the session and emails the
 * one-time accept link via `@lunora/mail` — so the token is mailed to the
 * invitee, never shown in the browser. Pending/accepted/revoked status comes
 * from the live `invitations.list` query; revoking stays a direct mutation.
 *
 * Hierarchy: the invitee's address is the row's identity and leads at full
 * contrast; role and lifecycle status are chips that tint the VALUE only; the
 * expiry is tertiary — mono caps, muted, and only shown while it still matters.
 * The post-send confirmation is inline status text, not a toast.
 */
export const InvitationsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.invitations.list>>): ReactElement => {
    const invitations = usePreloadedQuery(preloaded);
    const revoke = useMutation(api.invitations.revoke);

    const [email, setEmail] = useState("");
    const [sentTo, setSentTo] = useState<null | string>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<null | string>(null);

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Invitations</CardTitle>
                </CardHeader>
                <CardContent>
                    <AsyncList
                        empty="No invitations yet."
                        render={(rows) => (
                            <RowList>
                                {rows.map((entry) => (
                                    <Row key={entry._id}>
                                        <span className="min-w-0 flex-1 truncate font-medium">{entry.email}</span>
                                        <StatusBadge>{entry.role}</StatusBadge>
                                        <StatusBadge tone={INVITATION_TONE[entry.status]}>{entry.status}</StatusBadge>
                                        {entry.status === "pending" ? (
                                            <span className={cn(COLUMN_LABEL, "text-muted-foreground hidden whitespace-nowrap sm:inline")}>
                                                expires {formatDate(entry.expiresAt)}
                                            </span>
                                        ) : null}
                                        <RowActions>
                                            {entry.status === "pending" ? (
                                                <Button
                                                    className="text-destructive hover:text-destructive"
                                                    onClick={() => {
                                                        void revoke.mutate({ id: entry._id, organizationId });
                                                    }}
                                                    size="sm"
                                                    type="button"
                                                    variant="ghost"
                                                >
                                                    Revoke
                                                </Button>
                                            ) : null}
                                        </RowActions>
                                    </Row>
                                ))}
                            </RowList>
                        )}
                        rows={invitations}
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Invite member</CardTitle>
                    <CardDescription>The accept link is emailed to the invitee — the one-time token is never shown here.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    {sentTo ? (
                        // Inline status, not a toast: it stays put until dismissed.
                        <div className="flex items-center gap-3" role="status">
                            <span className={cn(COLUMN_LABEL, "text-success")}>[sent]</span>
                            <span className="text-muted-foreground min-w-0 truncate text-sm">Invitation emailed to {sentTo}.</span>
                            <Button
                                className="ml-auto"
                                onClick={() => {
                                    setSentTo(null);
                                }}
                                size="sm"
                                type="button"
                                variant="ghost"
                            >
                                Dismiss
                            </Button>
                        </div>
                    ) : null}
                    <FieldForm
                        action={() => {
                            setError(null);
                            setPending(true);

                            // Promise combinators instead of try/finally so React
                            // Compiler can memoize the component (it can't lower
                            // try-with-finally or throw-in-try yet).
                            const send = async (): Promise<void> => {
                                const response = await fetch("/v1/invitations/send", {
                                    body: JSON.stringify({ email, organizationId }),
                                    credentials: "include",
                                    headers: { "content-type": "application/json" },
                                    method: "POST",
                                });

                                if (!response.ok) {
                                    const payload = (await response.json().catch(() => null)) as { error?: string } | null;

                                    setError(payload?.error ?? `invite failed (${String(response.status)})`);

                                    return;
                                }

                                setSentTo(email);
                                setEmail("");
                            };

                            void send()
                                .catch((error_: unknown) => {
                                    setError(error_ instanceof Error ? error_.message : "invite failed");
                                })
                                .finally(() => {
                                    setPending(false);
                                });
                        }}
                    >
                        <Field htmlFor="invite-email" label="Invitee email">
                            <Input
                                className="font-mono"
                                id="invite-email"
                                onChange={(event) => {
                                    setEmail(event.target.value);
                                }}
                                placeholder="teammate@example.com"
                                required
                                type="email"
                                value={email}
                            />
                        </Field>
                        <Button className="justify-self-start" disabled={pending} type="submit">
                            {pending ? "Sending…" : "Invite"}
                        </Button>
                        <FormError message={error} />
                    </FieldForm>
                </CardContent>
            </Card>
        </div>
    );
};
