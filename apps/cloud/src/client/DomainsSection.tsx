import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId, ProjectId } from "./types";

interface DomainsSectionProps {
    organizationId: OrgId;
    /** The section's primary query, resolved by its route loader on the edge. */
    preloaded: Preloaded<ReturnOf<typeof api.projects.listByOrg>>;
}

interface TxtRecord {
    txtName: string;
    txtToken: string;
}

/**
 * Domains tab (GAPS.md B1). Add a hostname to a project (the response carries
 * the `_lunora.&lt;host>` TXT record to create), then verify — the edge route
 * runs the DNS checks and records the outcome; the list is live, so the
 * verified badge flips on its own. Removing is a direct mutation.
 */
export const DomainsSection = ({ organizationId, preloaded }: DomainsSectionProps): ReactElement => {
    const projects = usePreloadedQuery(preloaded);
    const [projectId, setProjectId] = useState<ProjectId | "">("");
    const domains = useQuery(api.domains.list, projectId ? { organizationId, projectId } : "skip");
    const removeDomain = useMutation(api.domains.remove);

    const [hostname, setHostname] = useState("");
    const [txtRecord, setTxtRecord] = useState<TxtRecord | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const verify = (id: string): void => {
        setError(null);

        const run = async (): Promise<void> => {
            const response = await fetch("/v1/domains/verify", {
                body: JSON.stringify({ id, organizationId }),
                credentials: "include",
                headers: { "content-type": "application/json" },
                method: "POST",
            });
            const payload = (await response.json().catch(() => null)) as { txtOk?: boolean; verified?: boolean } | null;

            if (!response.ok) {
                setError((payload as { error?: string } | null)?.error ?? `verify failed (${String(response.status)})`);
            } else if (!payload?.verified) {
                setError(
                    payload?.txtOk ? "TXT ok — but the hostname does not point at the platform yet" : "TXT record not found yet — DNS may still be propagating",
                );
            }
        };

        void run().catch((error_: unknown) => {
            setError(error_ instanceof Error ? error_.message : "verify failed");
        });
    };

    return (
        <div className="stack">
            <section className="card">
                <h3>Custom domains</h3>
                <label htmlFor="domain-project">
                    Project
                    <select
                        id="domain-project"
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
                        empty="No custom domains for this project."
                        render={(rows) => (
                            <ul className="list">
                                {rows.map((domain) => (
                                    <li className="row" key={domain._id}>
                                        <span className="row-title">{domain.hostname}</span>
                                        {domain.redirectTo ? <span className="muted">→ {domain.redirectTo}</span> : null}
                                        <span className="badge">{domain.verifiedAt ? "verified" : "pending"}</span>
                                        {domain.verifiedAt ? null : (
                                            <button
                                                className="link"
                                                onClick={() => {
                                                    verify(domain._id);
                                                }}
                                                type="button"
                                            >
                                                Verify
                                            </button>
                                        )}
                                        <button
                                            className="link danger"
                                            onClick={() => {
                                                void removeDomain.mutate({ id: domain._id, organizationId });
                                            }}
                                            type="button"
                                        >
                                            Remove
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        rows={domains}
                    />
                ) : null}
            </section>

            {projectId ? (
                <section className="card">
                    <h3>Add domain</h3>
                    {txtRecord ? (
                        <div className="callout">
                            <p>
                                Create this TXT record, then hit Verify: <code>{txtRecord.txtName}</code> = <code>{txtRecord.txtToken}</code>
                            </p>
                            <button
                                className="link"
                                onClick={() => {
                                    setTxtRecord(null);
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

                            const add = async (): Promise<void> => {
                                const response = await fetch("/v1/domains", {
                                    body: JSON.stringify({ hostname, organizationId, projectId }),
                                    credentials: "include",
                                    headers: { "content-type": "application/json" },
                                    method: "POST",
                                });

                                if (!response.ok) {
                                    const payload = (await response.json().catch(() => null)) as { error?: string } | null;

                                    setError(payload?.error ?? `add failed (${String(response.status)})`);

                                    return;
                                }

                                // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Response.json() is `unknown` under workers-types; tsc requires the assertion
                                const record = (await response.json()) as TxtRecord;

                                setTxtRecord(record);
                                setHostname("");
                            };

                            void add()
                                .catch((error_: unknown) => {
                                    setError(error_ instanceof Error ? error_.message : "add failed");
                                })
                                .finally(() => {
                                    setPending(false);
                                });
                        }}
                    >
                        <input
                            aria-label="Hostname"
                            onChange={(event) => {
                                setHostname(event.target.value);
                            }}
                            placeholder="app.example.com"
                            required
                            value={hostname}
                        />
                        <button className="primary" disabled={pending} type="submit">
                            {pending ? "Adding…" : "Add"}
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
