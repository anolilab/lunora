import { useMutation, useQuery } from "@cirrus/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface InvitationsSectionProps {
    organizationId: OrgId;
}

/**
 * Invitations tab. `invitations.invite` returns a one-time token that the
 * invitee redeems via `invitations.accept`; it's surfaced once here so the
 * inviter can share the join link. Pending/accepted/revoked status comes from
 * the live list.
 */
export const InvitationsSection = ({ organizationId }: InvitationsSectionProps): ReactElement => {
    const invitations = useQuery(api.invitations.list, { organizationId });
    const invite = useMutation(api.invitations.invite);
    const revoke = useMutation(api.invitations.revoke);

    const [email, setEmail] = useState("");
    const [token, setToken] = useState<string | null>(null);
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
                {token ? (
                    <div className="callout">
                        <p>Share this invite token with the new member:</p>
                        <code className="secret">{token}</code>
                        <button
                            className="link"
                            onClick={() => {
                                setToken(null);
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

                        void (async () => {
                            try {
                                const result = await invite.mutate({ email, organizationId });
                                setToken(result.token);
                                setEmail("");
                            } catch (error_: unknown) {
                                setError(error_ instanceof Error ? error_.message : "invite failed");
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
                    <button className="primary" disabled={invite.pending} type="submit">
                        Invite
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
