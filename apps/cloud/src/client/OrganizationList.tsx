import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { CellId, OrgId } from "./types";

interface OrganizationListProps {
    onSelect: (id: OrgId) => void;
    /** Cells, server-rendered by the `/` route loader. */
    preloadedCells: Preloaded<ReturnOf<typeof api.cells.list>>;
    /** Organizations, server-rendered by the `/` route loader. */
    preloadedOrganizations: Preloaded<ReturnOf<typeof api.organizations.list>>;
}

/** Derive a url-safe slug from a free-text organization name. */
const slugify = (value: string): string => {
    let out = "";
    let lastDash = false;

    for (const char of value.toLowerCase()) {
        const ok = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");

        if (ok) {
            out += char;
            lastDash = false;
        } else if (!lastDash && out.length > 0) {
            out += "-";
            lastDash = true;
        }
    }

    while (out.endsWith("-")) {
        out = out.slice(0, -1);
    }

    return out;
};

/**
 * Organization picker + create form. Listing organizations and the cells they
 * land on both run through live Lunora queries; creating one routes through the
 * `organizations.create` mutation, which requires choosing the cell (account
 * shard) the org's tenants will be provisioned into.
 */
export const OrganizationList = ({ onSelect, preloadedCells, preloadedOrganizations }: OrganizationListProps): ReactElement => {
    // Seeded from the SSR render, then live over the WebSocket from mount on.
    const organizations = usePreloadedQuery(preloadedOrganizations);
    const cells = usePreloadedQuery(preloadedCells);
    const createOrg = useMutation(api.organizations.create);

    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [cellId, setCellId] = useState<CellId | "">("");
    const [error, setError] = useState<string | null>(null);

    const effectiveSlug = slug.trim() === "" ? slugify(name) : slug;

    return (
        <div className="stack">
            <section className="card">
                <h2>Your organizations</h2>
                <AsyncList
                    empty="No organizations yet — create your first one below."
                    render={(rows) => (
                        <ul className="list">
                            {rows.map((org) => (
                                <li key={org._id}>
                                    <button
                                        className="row-button"
                                        onClick={() => {
                                            onSelect(org._id);
                                        }}
                                        type="button"
                                    >
                                        <span className="row-title">{org.name}</span>
                                        <span className="badge">{org.plan}</span>
                                        <span className="muted">/{org.slug}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    rows={organizations}
                />
            </section>

            <section className="card">
                <h2>New organization</h2>
                <p className="muted">New organizations start on the free plan — upgrade later from the Billing tab.</p>
                {cells?.length === 0 ? (
                    <p className="muted">No cells registered yet. Register a cell (account shard) before creating an organization.</p>
                ) : null}
                <form
                    className="form-grid"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setError(null);

                        if (!cellId) {
                            setError("Select a cell");

                            return;
                        }

                        void (async () => {
                            try {
                                const id = await createOrg.mutate({ cellId, name, slug: effectiveSlug });
                                setName("");
                                setSlug("");
                                onSelect(id);
                            } catch (error_: unknown) {
                                setError(error_ instanceof Error ? error_.message : "create failed");
                            }
                        })();
                    }}
                >
                    <label htmlFor="org-name">
                        Name
                        <input
                            id="org-name"
                            onChange={(event) => {
                                setName(event.target.value);
                            }}
                            required
                            value={name}
                        />
                    </label>
                    <label htmlFor="org-slug">
                        Slug
                        <input
                            id="org-slug"
                            onChange={(event) => {
                                setSlug(event.target.value);
                            }}
                            placeholder={slugify(name) || "acme"}
                            value={slug}
                        />
                    </label>
                    <label htmlFor="org-cell">
                        Cell
                        <select
                            id="org-cell"
                            onChange={(event) => {
                                setCellId(event.target.value as CellId);
                            }}
                            value={cellId}
                        >
                            <option value="">Select a cell…</option>
                            {(cells ?? []).map((cell) => (
                                <option key={cell._id} value={cell._id}>
                                    {cell.name} ({cell.status})
                                </option>
                            ))}
                        </select>
                    </label>
                    <button className="primary" disabled={createOrg.pending} type="submit">
                        {createOrg.pending ? "Creating…" : "Create organization"}
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
