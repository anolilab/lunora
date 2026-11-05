/**
 * The platform admin's organisation list.
 *
 * Reads the `.global()` `saas_organizations` projection, which is the only
 * cross-tenant read the shard model allows. The list is paged (the saas kit's
 * `saas.listOrganizations` is a cursor query) and the search and plan filter
 * run on the server, so nothing here filters rows: this module turns the
 * admin's view into the query's arguments, and the header's totals come from
 * `saas.organizationTotals` over the same filter. Anything that would need a
 * tenant's own data belongs behind impersonation, not behind a widened admin
 * query.
 */
import type { Plan } from "./billing";

interface AdminView {
    /** Exact plan id, or `"all"`. */
    plan: string;
    search: string;
}

/** What `saas.organizationTotals` resolves to: the whole filtered set, not the pages loaded. */
interface OrganizationTotals {
    organizations: number;
    seats: number;
}

/** The filter `saas.listOrganizations` and `saas.organizationTotals` share. */
interface OrganizationFilter {
    plan?: string;
    search?: string;
}

/** The longest search the saas kit's list takes; the search box stops typing at it. */
const ORGANIZATION_SEARCH_MAX = 100;

const DEFAULT_ADMIN_VIEW: AdminView = { plan: "all", search: "" };

/**
 * The view's filter as query arguments: `"all"` and a blank search are simply
 * absent, and a pasted search is cut to the length the server accepts, which
 * refuses a longer one outright.
 */
const toOrganizationFilter = (view: AdminView): OrganizationFilter => {
    const search = view.search.trim().slice(0, ORGANIZATION_SEARCH_MAX);

    return {
        ...(view.plan === "all" ? {} : { plan: view.plan }),
        ...(search === "" ? {} : { search }),
    };
};

/**
 * The plan filter's options, from the catalog in its own order. The catalog
 * rather than the rows: a page holds only some tenants, and a filter that
 * offered only the plans on screen could never reach the rest.
 */
const planOptions = (plans: ReadonlyArray<Pick<Plan, "id" | "name">>): ReadonlyArray<{ label: string; value: string }> => [
    { label: "All plans", value: "all" },
    ...plans.map((plan) => {
        return { label: plan.name, value: plan.id };
    }),
];

export type { AdminView, OrganizationFilter, OrganizationTotals };
export { DEFAULT_ADMIN_VIEW, ORGANIZATION_SEARCH_MAX, planOptions, toOrganizationFilter };
