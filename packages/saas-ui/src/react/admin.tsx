"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import type { AdminView } from "../core/admin-organizations";
import { adminTotals, DEFAULT_ADMIN_VIEW, planOptions, selectOrganizations } from "../core/admin-organizations";
import type { AdminSubscriptionRow, SubscriptionsView } from "../core/admin-subscriptions";
import { DEFAULT_SUBSCRIPTIONS_VIEW, selectSubscriptions, subscriptionStateOptions, subscriptionTotals } from "../core/admin-subscriptions";
import type { Plan } from "../core/billing";
import { planLabel, relativeTime } from "../core/format";
import type { OrganizationRow } from "../core/types";
import { Card, Empty } from "./primitives";

interface AdminOrganizationsProps {
    now: number;
    rows: ReadonlyArray<OrganizationRow> | undefined;
    /** IANA zone an older update's date is shown in — the viewer's. UTC when omitted. */
    timeZone?: string;
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
const AdminOrganizations = ({ now, rows, timeZone }: AdminOrganizationsProps): ReactNode => {
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
                                <td>{relativeTime(organization.updatedAt, now, timeZone)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Card>
    );
};

interface AdminSubscriptionsProps {
    /** The organisation list, for names. Subscriptions render with ids until it arrives. */
    organizations: ReadonlyArray<OrganizationRow> | undefined;
    plans: ReadonlyArray<Plan>;
    /** `undefined` while the query is in flight. */
    rows: ReadonlyArray<AdminSubscriptionRow> | undefined;
}

/**
 * Every tenant's subscription, dunning tenants first. Read-only for the same
 * reason as the organisation table: a change to a subscription is made in the
 * provider's dashboard or through the tenant's own billing page, and the
 * webhook brings it back here.
 */
const AdminSubscriptions = ({ organizations, plans, rows }: AdminSubscriptionsProps): ReactNode => {
    const [view, setView] = useState<SubscriptionsView>(DEFAULT_SUBSCRIPTIONS_VIEW);

    if (!rows) {
        return (
            <Card title="Subscriptions">
                <div aria-busy="true" className="lu-saas-list lu-saas-list--loading" />
            </Card>
        );
    }

    const totals = subscriptionTotals(rows);
    const visible = selectSubscriptions(rows, organizations ?? [], plans, view);

    return (
        <Card subtitle={`${totals.paying.toString()} paying · ${totals.pastDue.toString()} past due`} title="Subscriptions">
            <div className="lu-saas-toolbar">
                <input
                    aria-label="Search subscriptions"
                    className="lu-saas-input"
                    onChange={(event) => {
                        setView({ ...view, search: event.target.value });
                    }}
                    placeholder="Search"
                    type="search"
                    value={view.search}
                />
                <select
                    aria-label="Filter by state"
                    className="lu-saas-select"
                    onChange={(event) => {
                        setView({ ...view, state: event.target.value });
                    }}
                    value={view.state}
                >
                    {subscriptionStateOptions(rows).map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>

            {visible.length === 0 ? (
                <Empty title={rows.length === 0 ? "No subscriptions yet" : "Nothing matches that filter"} />
            ) : (
                <table className="lu-saas-table">
                    <thead>
                        <tr>
                            <th scope="col">Organization</th>
                            <th scope="col">Plan</th>
                            <th scope="col">State</th>
                            <th scope="col">Seats</th>
                            <th scope="col">Renewal</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((subscription) => (
                            <tr key={subscription.id}>
                                <td>
                                    {subscription.organization}
                                    <code className="lu-saas-row__slug">{subscription.id}</code>
                                </td>
                                <td>{subscription.plan}</td>
                                <td>{planLabel(subscription.state)}</td>
                                <td>{subscription.quantity}</td>
                                <td>{subscription.renewal}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Card>
    );
};

export type { AdminOrganizationsProps, AdminSubscriptionsProps };
export { AdminOrganizations, AdminSubscriptions };
