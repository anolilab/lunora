import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface DeployKeysSectionProps {
    organizationId: OrgId;
    /** The section's primary query, resolved by its route loader on the edge. */
    preloaded: Preloaded<ReturnOf<typeof api.deploy_keys.list>>;
}

const KEY_TYPES = ["production", "preview", "dev"] as const;

/**
 * Deploy-keys tab. Keys are stored hashed server-side, so the plaintext secret
 * is shown exactly once — right after `deploy_keys.issue` returns it — and never
 * again. Revoked keys stay listed (with their `revokedAt`) for the audit trail.
 */
export const DeployKeysSection = ({ organizationId, preloaded }: DeployKeysSectionProps): ReactElement => {
    const keys = usePreloadedQuery(preloaded);
    const issueKey = useMutation(api.deploy_keys.issue);
    const revokeKey = useMutation(api.deploy_keys.revoke);

    const [name, setName] = useState("");
    const [type, setType] = useState<(typeof KEY_TYPES)[number]>("production");
    const [issued, setIssued] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    return (
        <div className="stack">
            <section className="card">
                <h3>Deploy keys</h3>
                <AsyncList
                    empty="No deploy keys yet."
                    render={(rows) => (
                        <ul className="list">
                            {rows.map((key) => (
                                <li className="row" key={key._id}>
                                    <span className="row-title">{key.name}</span>
                                    <span className="badge">{key.type}</span>
                                    {key.revokedAt ? (
                                        <span className="muted">revoked</span>
                                    ) : (
                                        <button
                                            className="link danger"
                                            onClick={() => {
                                                void revokeKey.mutate({ id: key._id, organizationId });
                                            }}
                                            type="button"
                                        >
                                            Revoke
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    rows={keys}
                />
            </section>

            <section className="card">
                <h3>Issue key</h3>
                {issued ? (
                    <div className="callout">
                        <p>Copy this key now — it cannot be shown again:</p>
                        <code className="secret">{issued}</code>
                        <button
                            className="link"
                            onClick={() => {
                                setIssued(null);
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
                                const result = await issueKey.mutate({ name, organizationId, type });
                                setIssued(result.key);
                                setName("");
                            } catch (error_: unknown) {
                                setError(error_ instanceof Error ? error_.message : "issue failed");
                            }
                        })();
                    }}
                >
                    <input
                        aria-label="Key name"
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                        placeholder="CI production"
                        required
                        value={name}
                    />
                    <select
                        aria-label="Key type"
                        onChange={(event) => {
                            setType(event.target.value as (typeof KEY_TYPES)[number]);
                        }}
                        value={type}
                    >
                        {KEY_TYPES.map((value) => (
                            <option key={value} value={value}>
                                {value}
                            </option>
                        ))}
                    </select>
                    <button className="primary" disabled={issueKey.pending} type="submit">
                        Issue
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
