"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import type { AdminView, OrganizationRow } from "../core";
import { adminTotals, DEFAULT_ADMIN_VIEW, planLabel, planOptions, relativeTime, selectOrganizations } from "../core";
import { Card, Empty } from "./primitives";

interface AdminOrganizationsProps {
    now: number;
    rows: ReadonlyArray<OrganizationRow> | undefined;
}

/**
 * The platform admin's organisation table.
 *
 * Read-only by design. Every write an admin might want here belongs to the
 * tenant's own shard, and reaching into it from a cross-tenant screen is how a
 * tenancy boundary stops meaning anything — the supported path is better-auth's
 * impersonation, which puts the admin inside the tenant with the tenant's own
 * authorisation applied.
 */
const AdminOrganizations = ({ now, rows }: AdminOrganizationsProps): ReactNode => {
    const [view, setView] = useState<AdminView>(DEFAULT_ADMIN_VIEW);

    if (!rows) {
        return (
            <Card title="Organizations">
                <div aria-busy="true" className="lu-saas-list lu-saas-list--loading" />
            </Card>
        );
    }

    const totals = adminTotals(rows);
    const visible = selectOrganizations(rows, view);

    return (
        <Card subtitle={`${totals.organizations.toString()} organizations · ${totals.seats.toString()} seats`} title="Organizations">
            <div className="lu-saas-toolbar">
                <input
                    aria-label="Search organizations"
                    className="lu-saas-input"
                    onChange={(event) => {
                        setView({ ...view, search: event.target.value });
                    }}
                    placeholder="Search"
                    type="search"
                    value={view.search}
                />
                <select
                    aria-label="Filter by plan"
                    className="lu-saas-select"
                    onChange={(event) => {
                        setView({ ...view, plan: event.target.value });
                    }}
                    value={view.plan}
                >
                    {planOptions(rows).map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>

            {visible.length === 0 ? (
                <Empty title="Nothing matches that filter" />
            ) : (
                <table className="lu-saas-table">
                    <thead>
                        <tr>
                            <th scope="col">Organization</th>
                            <th scope="col">Plan</th>
                            <th scope="col">Seats</th>
                            <th scope="col">Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((organization) => (
                            <tr key={organization._id}>
                                <td>
                                    {organization.name}
                                    <code className="lu-saas-row__slug">{organization.slug}</code>
                                </td>
                                <td>{planLabel(organization.plan)}</td>
                                <td>{organization.seats}</td>
                                <td>{relativeTime(organization.updatedAt, now)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Card>
    );
};

export type { AdminOrganizationsProps };
export { AdminOrganizations };
