/**
 * The platform admin's subscription list: every tenant's billing state on one
 * screen, joined to the organisation it bills.
 *
 * The payment tables are root-scoped (a provider webhook carries no tenant to
 * pick a shard by), so this is one root-shard read, not a fan-out — the same
 * shape of cross-tenant read as the `.global()` organisation projection. It is
 * paged (the saas template's `payment.adminSubscriptions` is a cursor query), so
 * the rows here are the pages loaded so far, and the filter, the ordering and
 * the paying total cover those rather than the whole table. Dunning is the
 * exception: a newest-first page would leave an older past-due tenant unseen
 * until the admin paged back to it, so every past-due subscription arrives from
 * a read of its own (`payment.adminPastDueSubscriptions`) and is merged in ahead
 * of the pages. The
 * join happens here rather than in the query because the organisation names
 * already arrive with the organisation list, and the payment functions should
 * not have to know the kit's tenancy table exists.
 */
import type { Plan } from "./billing";
import { dayKey, planLabel } from "./format";
import type { OrganizationRow, SubscriptionLike } from "./types";

/** A subscription as an admin query returns it: the billing slice plus whose it is. */
interface AdminSubscriptionRow extends SubscriptionLike {
    /** The billing provider (`stripe`, `polar`, …). Its subscription ids are unique only within it. */
    provider: string;
    providerSubscriptionId: string;
    /** The organisation id the subscription bills. */
    referenceId: string;
}

/** The dunning read: every past-due subscription, up to a cap that `more` says was hit. */
interface PastDueSubscriptions {
    more: boolean;
    rows: ReadonlyArray<AdminSubscriptionRow>;
}

interface SubscriptionListing {
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd?: number;
    /** The provider's own subscription id, as shown and searched. */
    id: string;
    /** `provider:id` — unique where `id` alone is not, so it is the row's key. */
    key: string;
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

/** A subscription's identity: the payment store keys it by provider and provider id together. */
const subscriptionKey = (subscription: Pick<AdminSubscriptionRow, "provider" | "providerSubscriptionId">): string =>
    `${subscription.provider}:${subscription.providerSubscriptionId}`;

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
                    key: subscriptionKey(subscription),
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
 * The rows the table lists: every past-due subscription first, then the pages
 * loaded so far, without the past-due rows a page repeats. The table's own sort
 * then only orders what is here — it is presentation, not what brings dunning up.
 */
const withPastDueFirst = (pastDue: ReadonlyArray<AdminSubscriptionRow>, paged: ReadonlyArray<AdminSubscriptionRow>): ReadonlyArray<AdminSubscriptionRow> => {
    const seen = new Set(pastDue.map((subscription) => subscriptionKey(subscription)));

    return [...pastDue, ...paged.filter((subscription) => !seen.has(subscriptionKey(subscription)))];
};

/**
 * The card's header. While more pages remain the totals are of the loaded rows
 * only, and say so — a "0 past due" over the first page is not a fact about
 * every tenant. Given the dunning read, the past-due count is the whole table's
 * (with a `+` past its cap), and only the paying count is partial.
 */
const subscriptionsSubtitle = (subscriptions: ReadonlyArray<AdminSubscriptionRow>, hasMore: boolean, pastDue?: PastDueSubscriptions): string => {
    const totals = subscriptionTotals(subscriptions);
    const loaded = hasMore ? ` in the ${subscriptions.length.toString()} loaded` : "";

    if (pastDue === undefined) {
        return `${totals.paying.toString()} paying · ${totals.pastDue.toString()} past due${loaded}`;
    }

    return `${totals.paying.toString()} paying${loaded} · ${pastDue.rows.length.toString()}${pastDue.more ? "+" : ""} past due`;
};

export type { AdminSubscriptionRow, PastDueSubscriptions, SubscriptionListing, SubscriptionsView };
export { DEFAULT_SUBSCRIPTIONS_VIEW, selectSubscriptions, subscriptionsSubtitle, subscriptionStateOptions, subscriptionTotals, withPastDueFirst };
