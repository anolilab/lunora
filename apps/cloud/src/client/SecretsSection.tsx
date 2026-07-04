import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId, ProjectId } from "./types";

interface SecretsSectionProps {
    organizationId: OrgId;
}

/**
 * Secrets tab (§7). Per-project tenant env vars. Setting a secret POSTs to the
 * `/v1/secrets` edge route, which encrypts the value (the master key never
 * reaches the browser) before storing ciphertext; `list` returns names only, and
 * the values are decrypted only at deploy time. Pick a project, then manage its
 * secrets.
 */
export const SecretsSection = ({ organizationId }: SecretsSectionProps): ReactElement => {
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const [projectId, setProjectId] = useState<ProjectId | "">("");
    const secrets = useQuery(api.secrets.list, projectId ? { organizationId, projectId } : "skip");
    const removeSecret = useMutation(api.secrets.remove);

    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    return (
        <div className="stack">
            <section className="card">
                <h3>Secrets</h3>
                <label htmlFor="secret-project">
                    Project
                    <select
                        id="secret-project"
                        onChange={(event) => {
                            setProjectId(event.target.value as ProjectId);
                        }}
                        value={projectId}
                    >
                        <option value="">Select a project…</option>
                        {(projects ?? []).map((project) => (
                            <option key={project._id} value={project._id}>
                                {project.name}
                            </option>
                        ))}
                    </select>
                </label>

                {projectId ? (
                    <AsyncList
                        empty="No secrets for this project."
                        render={(rows) => (
                            <ul className="list">
                                {rows.map((secret) => (
                                    <li className="row" key={secret.name}>
                                        <span className="row-title">{secret.name}</span>
                                        <span className="muted">set {new Date(secret.updatedAt).toLocaleDateString()}</span>
                                        <button
                                            className="link danger"
                                            onClick={() => {
                                                void removeSecret.mutate({ id: secret.id, organizationId });
                                            }}
                                            type="button"
                                        >
                                            Delete
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        rows={secrets}
                    />
                ) : null}
            </section>

            {projectId ? (
                <section className="card">
                    <h3>Set secret</h3>
                    <form
                        className="inline-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            setError(null);
                            setPending(true);

                            // Promise combinators instead of try/finally so React
                            // Compiler can memoize the component (it can't lower
                            // try-with-finally or throw-in-try yet).
                            const save = async (): Promise<void> => {
                                const response = await fetch("/v1/secrets", {
                                    body: JSON.stringify({ name, organizationId, projectId, value }),
                                    credentials: "include",
                                    headers: { "content-type": "application/json" },
                                    method: "POST",
                                });

                                if (!response.ok) {
                                    const payload = (await response.json().catch(() => null)) as { error?: string } | null;

                                    setError(payload?.error ?? `set failed (${String(response.status)})`);

                                    return;
                                }

                                setName("");
                                setValue("");
                            };

                            void save()
                                .catch((error_: unknown) => {
                                    setError(error_ instanceof Error ? error_.message : "set failed");
                                })
                                .finally(() => {
                                    setPending(false);
                                });
                        }}
                    >
                        <input
                            aria-label="Secret name"
                            onChange={(event) => {
                                setName(event.target.value);
                            }}
                            placeholder="STRIPE_SECRET_KEY"
                            required
                            value={name}
                        />
                        <input
                            aria-label="Secret value"
                            onChange={(event) => {
                                setValue(event.target.value);
                            }}
                            placeholder="value"
                            required
                            type="password"
                            value={value}
                        />
                        <button className="primary" disabled={pending} type="submit">
                            {pending ? "Saving…" : "Set"}
                        </button>
                        {error ? (
                            <p className="error" role="alert">
                                {error}
                            </p>
                        ) : null}
                    </form>
                </section>
            ) : null}
        </div>
    );
};
