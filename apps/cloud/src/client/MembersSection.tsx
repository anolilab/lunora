import { useMutation, useQuery } from "@cirrus/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface MembersSectionProps {
    organizationId: OrgId;
}

/**
 * Members tab: the org's members (live) with their roles, plus an add-by-user-id
 * control. New members default to the `member` role server-side; role changes
 * and ownership transfer are governed by `authz.assertMember`.
 */
export const MembersSection = ({ organizationId }: MembersSectionProps): ReactElement => {
    const members = useQuery(api.members.list, { organizationId });
    const addMember = useMutation(api.members.add);
    const removeMember = useMutation(api.members.remove);

    const [userId, setUserId] = useState("");
    const [error, setError] = useState<string | null>(null);

    return (
        <div className="stack">
            <section className="card">
                <h3>Members</h3>
                <AsyncList
                    empty="No members yet."
                    render={(rows) => (
                        <ul className="list">
                            {rows.map((member) => (
                                <li className="row" key={member._id}>
                                    <span className="row-title">{member.userId}</span>
                                    <span className="badge">{member.role}</span>
                                    <button
                                        className="link danger"
                                        onClick={() => {
                                            void removeMember.mutate({ id: member._id, organizationId });
                                        }}
                                        type="button"
                                    >
                                        Remove
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    rows={members}
                />
            </section>

            <section className="card">
                <h3>Add member</h3>
                <form
                    className="inline-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setError(null);

                        void (async () => {
                            try {
                                await addMember.mutate({ organizationId, userId });
                                setUserId("");
                            } catch (error_: unknown) {
                                setError(error_ instanceof Error ? error_.message : "add failed");
                            }
                        })();
                    }}
                >
                    <input
                        aria-label="User id"
                        onChange={(event) => {
                            setUserId(event.target.value);
                        }}
                        placeholder="user id"
                        required
                        value={userId}
                    />
                    <button className="primary" disabled={addMember.pending} type="submit">
                        Add
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
