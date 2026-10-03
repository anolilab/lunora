/**
 * The platform admin's organisation list.
 *
 * Reads the `.global()` `saas_organizations` projection, which is the only
 * cross-tenant read the shard model allows — so everything here is a selector
 * over the rows that one query returns. Anything that would need a tenant's own
 * data belongs behind impersonation, not behind a widened admin query.
 */
import { planLabel } from "./format";
import type { OrganizationRow } from "./types";

type OrganizationSort = "name" | "plan" | "seats" | "updated";

interface AdminView {
    /** Exact plan id, or `"all"`. */
    plan: string;
    search: string;
    sort: OrganizationSort;
    /** Exact status, or `"all"`. */
    status: string;
}

const DEFAULT_ADMIN_VIEW: AdminView = { plan: "all", search: "", sort: "updated", status: "all" };

const COMPARATORS: Record<OrganizationSort, (a: OrganizationRow, b: OrganizationRow) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    plan: (a, b) => a.plan.localeCompare(b.plan) || a.name.localeCompare(b.name),
    seats: (a, b) => b.seats - a.seats,
    updated: (a, b) => b.updatedAt - a.updatedAt,
};

const selectOrganizations = (rows: ReadonlyArray<OrganizationRow>, view: AdminView = DEFAULT_ADMIN_VIEW): ReadonlyArray<OrganizationRow> => {
    const needle = view.search.trim().toLowerCase();

    return rows
        .filter(
            (organization) =>
                (view.plan === "all" || organization.plan === view.plan) &&
                (view.status === "all" || organization.status === view.status) &&
                (needle === "" || organization.name.toLowerCase().includes(needle) || organization.slug.toLowerCase().includes(needle)),
        )
        .toSorted(COMPARATORS[view.sort]);
};

/** The distinct plans present, for the filter control. Sorted for a stable UI. */
const planOptions = (rows: ReadonlyArray<OrganizationRow>): ReadonlyArray<{ label: string; value: string }> => [
    { label: "All plans", value: "all" },
    ...[...new Set(rows.map((organization) => organization.plan))]
        .toSorted((a, b) => a.localeCompare(b))
        .map((plan) => {
            return { label: planLabel(plan), value: plan };
        }),
];

/** Totals for the admin header. Seats are summed from the projection, not counted per tenant. */
const adminTotals = (rows: ReadonlyArray<OrganizationRow>): { organizations: number; seats: number } => {
    return {
        organizations: rows.length,
        seats: rows.reduce((total, organization) => total + organization.seats, 0),
    };
};

export type { AdminView, OrganizationSort };
export { adminTotals, DEFAULT_ADMIN_VIEW, planOptions, selectOrganizations };
