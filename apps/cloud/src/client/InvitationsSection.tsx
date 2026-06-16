import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface InvitationsSectionProps {
    organizationId: OrgId;
}

/**
 * Invitations tab. Inviting POSTs to the control plane's `/v1/invitations/send`
 * edge route, which runs `invitations.invite` under the session and emails the
 * one-time accept link via `@lunora/mail` — so the token is mailed to the
 * invitee, never shown in the browser. Pending/accepted/revoked status comes
 * from the live `invitations.list` query; revoking stays a direct mutation.
 */
export const InvitationsSection = ({ organizationId }: InvitationsSectionProps): ReactElement => {
    const invitations = useQuery(api.invitations.list, { organizationId });
    const revoke = useMutation(api.invitations.revoke);

    const [email, setEmail] = useState("");
    const [sentTo, setSentTo] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    return (
        <div className="stack">
            <section className="card">
                <h3>Invitations</h3>
                <AsyncList
                    empty="No invitations yet."
                    render={(rows) => (
                        <ul className="list">
                            {rows.map((entry) => (
                                <li className="row" key={entry._id}>
                                    <span className="row-title">{entry.email}</span>
                                    <span className="badge">{entry.role}</span>
                                    <span className="muted">{entry.status}</span>
                                    {entry.status === "pending" ? (
                                        <button
                                            className="link danger"
                                            onClick={() => {
                                                void revoke.mutate({ id: entry._id, organizationId });
                                            }}
                                            type="button"
                                        >
                                            Revoke
                                        </button>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                    rows={invitations}
                />
            </section>

            <section className="card">
                <h3>Invite member</h3>
                {sentTo ? (
                    <div className="callout">
                        <p>Invitation emailed to {sentTo}.</p>
                        <button
                            className="link"
                            onClick={() => {
                                setSentTo(null);
                            }}
                            type="button"
                        >
                            Dismiss
                        </button>
                    </div>
                ) : null}
                <form
                    className="inline-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setError(null);
                        setPending(true);

                        void (async () => {
                            try {
                                const response = await fetch("/v1/invitations/send", {
                                    body: JSON.stringify({ email, organizationId }),
                                    credentials: "include",
                                    headers: { "content-type": "application/json" },
                                    method: "POST",
                                });

                                if (!response.ok) {
                                    const payload = (await response.json().catch(() => null)) as { error?: string } | null;

                                    throw new Error(payload?.error ?? `invite failed (${String(response.status)})`);
                                }

                                setSentTo(email);
                                setEmail("");
                            } catch (error_: unknown) {
                                setError(error_ instanceof Error ? error_.message : "invite failed");
                            } finally {
                                setPending(false);
                            }
                        })();
                    }}
                >
                    <input
                        aria-label="Invitee email"
                        onChange={(event) => {
                            setEmail(event.target.value);
                        }}
                        placeholder="teammate@example.com"
                        required
                        type="email"
                        value={email}
                    />
                    <button className="primary" disabled={pending} type="submit">
                        {pending ? "Sending…" : "Invite"}
                    </button>
                    {error ? (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </form>
            </section>
        </div>
    );
};
