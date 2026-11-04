/**
 * The platform admin's organisation list.
 *
 * Reads the `.global()` `saas_organizations` projection, which is the only
 * cross-tenant read the shard model allows. The list is paged (the saas kit's
 * `saas.listOrganizations` is a cursor query) and the search, filters and sort
 * run on the server, so nothing here filters rows: this module turns the
 * admin's view into the query's arguments, and the header's totals come from
 * `saas.organizationTotals` over the same filter. Anything that would need a
 * tenant's own data belongs behind impersonation, not behind a widened admin
 * query.
 */
import type { Plan } from "./billing";

type OrganizationSort = "name" | "plan" | "seats" | "updated";

interface AdminView {
    /** Exact plan id, or `"all"`. */
    plan: string;
    search: string;
    sort: OrganizationSort;
    /** Exact status, or `"all"`. */
    status: string;
}

/** What `saas.organizationTotals` resolves to: the whole filtered set, not the pages loaded. */
interface OrganizationTotals {
    organizations: number;
    seats: number;
}

/** The filter `saas.listOrganizations` and `saas.organizationTotals` share. The list also takes `sort`. */
interface OrganizationFilterArgs {
    plan?: string;
    search?: string;
    status?: string;
}

const DEFAULT_ADMIN_VIEW: AdminView = { plan: "all", search: "", sort: "updated", status: "all" };

/** The view's filter as query arguments: `"all"` and a blank search are simply absent. */
const organizationFilterArgs = (view: AdminView): OrganizationFilterArgs => {
    const search = view.search.trim();

    return {
        ...(view.plan === "all" ? {} : { plan: view.plan }),
        ...(search === "" ? {} : { search }),
        ...(view.status === "all" ? {} : { status: view.status }),
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

export type { AdminView, OrganizationFilterArgs, OrganizationSort, OrganizationTotals };
export { DEFAULT_ADMIN_VIEW, organizationFilterArgs, planOptions };
