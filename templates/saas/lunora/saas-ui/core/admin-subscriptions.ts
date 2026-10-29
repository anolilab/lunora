/**
 * The platform admin's subscription list: every tenant's billing state on one
 * screen, joined to the organisation it bills.
 *
 * The payment tables are root-scoped (a provider webhook carries no tenant to
 * pick a shard by), so this is one root-shard read, not a fan-out — the same
 * shape of cross-tenant read as the `.global()` organisation projection. It is
 * paged (the saas template's `payment.adminSubscriptions` is a cursor query), so
 * the rows here are the pages loaded so far, and the filter, the ordering and
 * the totals cover those rather than the whole table. The
 * join happens here rather than in the query because the organisation names
 * already arrive with the organisation list, and the payment functions should
 * not have to know the kit's tenancy table exists.
 */
import type { Plan } from "./billing";
import { dayKey, planLabel } from "./format";
import type { OrganizationRow, SubscriptionLike } from "./types";

/** A subscription as an admin query returns it: the billing slice plus whose it is. */
interface AdminSubscriptionRow extends SubscriptionLike {
    providerSubscriptionId: string;
    /** The organisation id the subscription bills. */
    referenceId: string;
}

interface SubscriptionListing {
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd?: number;
    id: string;
    /** The organisation's name, or its id when the projection has no row for it (a deleted tenant). */
    organization: string;
    /** The catalog's name for the plan billed, or the raw price id when the catalog does not list it. */
    plan: string;
    quantity: number;
    /** "Renews 2026-11-28", "Ends 2026-11-28" when it cancels at period end, or a dash. */
    renewal: string;
    state: string;
}

interface SubscriptionsView {
    search: string;
    /** Exact state, or `"all"`. */
    state: string;
}

const DEFAULT_SUBSCRIPTIONS_VIEW: SubscriptionsView = { search: "", state: "all" };

/**
 * `@lunora/payment`'s subscription states, worst first — the order an admin
 * works a list in. A dunning tenant matters more than a happy one.
 */
const STATE_ORDER: ReadonlyArray<string> = ["past_due", "paused", "trialing", "active", "canceled"];

const stateRank = (state: string): number => {
    const index = STATE_ORDER.indexOf(state);

    return index === -1 ? STATE_ORDER.length : index;
};

/** The plan a subscription bills, whatever its state — unlike `currentPlan`, which only answers for an entitling one. */
const planName = (plans: ReadonlyArray<Plan>, subscription: SubscriptionLike): string => {
    const billed = new Set(subscription.priceIds ?? [subscription.priceId]);

    return plans.find((plan) => plan.priceId !== undefined && billed.has(plan.priceId))?.name ?? subscription.priceId;
};

const renewal = (subscription: SubscriptionLike): string => {
    if (subscription.state === "canceled" || subscription.currentPeriodEnd === undefined) {
        return "—";
    }

    return `${subscription.cancelAtPeriodEnd ? "Ends" : "Renews"} ${dayKey(subscription.currentPeriodEnd)}`;
};

const selectSubscriptions = (
    subscriptions: ReadonlyArray<AdminSubscriptionRow>,
    organizations: ReadonlyArray<OrganizationRow>,
    plans: ReadonlyArray<Plan>,
    view: SubscriptionsView = DEFAULT_SUBSCRIPTIONS_VIEW,
): ReadonlyArray<SubscriptionListing> => {
    const byId = new Map(organizations.map((organization) => [organization.organizationId, organization]));
    const needle = view.search.trim().toLowerCase();

    return subscriptions
        .filter((subscription) => view.state === "all" || subscription.state === view.state)
        .map((subscription) => {
            const organization = byId.get(subscription.referenceId);

            return {
                listing: {
                    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                    currentPeriodEnd: subscription.currentPeriodEnd,
                    id: subscription.providerSubscriptionId,
                    organization: organization?.name ?? subscription.referenceId,
                    plan: planName(plans, subscription),
                    quantity: subscription.quantity,
                    renewal: renewal(subscription),
                    state: subscription.state,
                },
                slug: organization?.slug ?? "",
            };
        })
        .filter(
            ({ listing, slug }) =>
                needle === "" ||
                listing.organization.toLowerCase().includes(needle) ||
                slug.toLowerCase().includes(needle) ||
                listing.id.toLowerCase().includes(needle),
        )
        .map(({ listing }) => listing)
        .toSorted((a, b) => stateRank(a.state) - stateRank(b.state) || a.organization.localeCompare(b.organization));
};

/** The distinct states present, for the filter control, in {@link STATE_ORDER}. */
const subscriptionStateOptions = (subscriptions: ReadonlyArray<AdminSubscriptionRow>): ReadonlyArray<{ label: string; value: string }> => [
    { label: "All states", value: "all" },
    ...[...new Set(subscriptions.map((subscription) => subscription.state))]
        .toSorted((a, b) => stateRank(a) - stateRank(b) || a.localeCompare(b))
        .map((state) => {
            return { label: planLabel(state), value: state };
        }),
];

/**
 * Header totals. "Paying" is `active` and `trialing` — the states that entitle —
 * and "past due" is dunning, which entitles nothing and cancels if nobody looks.
 */
const subscriptionTotals = (subscriptions: ReadonlyArray<AdminSubscriptionRow>): { pastDue: number; paying: number } => {
    return {
        pastDue: subscriptions.filter((subscription) => subscription.state === "past_due").length,
        paying: subscriptions.filter((subscription) => subscription.state === "active" || subscription.state === "trialing").length,
    };
};

/**
 * The card's header. While more pages remain the totals are of the loaded rows
 * only, and say so — a "0 past due" over the first page is not a fact about
 * every tenant.
 */
const subscriptionsSubtitle = (subscriptions: ReadonlyArray<AdminSubscriptionRow>, hasMore: boolean): string => {
    const { pastDue, paying } = subscriptionTotals(subscriptions);
    const totals = `${paying.toString()} paying · ${pastDue.toString()} past due`;

    return hasMore ? `${totals} in the ${subscriptions.length.toString()} loaded` : totals;
};

export type { AdminSubscriptionRow, SubscriptionListing, SubscriptionsView };
export { DEFAULT_SUBSCRIPTIONS_VIEW, selectSubscriptions, subscriptionsSubtitle, subscriptionStateOptions, subscriptionTotals };
