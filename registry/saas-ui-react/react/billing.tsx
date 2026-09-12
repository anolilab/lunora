"use client";

import type { ReactNode } from "react";

import type { Plan, SubscriptionLike } from "../core";
import { currentPlan, isEntitled, pricingRows, seatUsage, subscriptionNotice } from "../core";
import { Card, Empty } from "./primitives";

interface PricingTableProps {
    /** Start checkout for a plan's provider price id. */
    /** Start checkout. The return is ignored, so an async handler is fine. */
    onSelect: (priceId: string) => unknown;
    plans: ReadonlyArray<Plan>;
    subscription: SubscriptionLike | undefined;
}

/**
 * The pricing table. Downgrades are not offered here on purpose — they go
 * through the provider's portal, because proration is not a thing an app should
 * reimplement.
 */
const PricingTable = ({ onSelect, plans, subscription }: PricingTableProps): ReactNode => (
    <div className="lu-saas-stats">
        {pricingRows(plans, subscription).map(({ current, plan, price, priceId, purchasable }) => (
            <div className={current ? "lu-saas-stat lu-saas-stat--current" : "lu-saas-stat"} key={plan.id}>
                <span className="lu-saas-stat__label">{plan.name}</span>
                <span className="lu-saas-stat__value">{price}</span>
                <span className="lu-saas-stat__note">{plan.blurb}</span>
                <ul className="lu-saas-list">
                    {plan.features.map((feature) => (
                        <li className="lu-saas-row" key={feature}>
                            {feature}
                        </li>
                    ))}
                </ul>
                {current ? (
                    <span className="lu-saas-stat__note">Current plan</span>
                ) : (
                    purchasable &&
                    priceId !== undefined && (
                        <button
                            className="lu-saas-button"
                            onClick={() => {
                                onSelect(priceId);
                            }}
                            type="button"
                        >
                            Choose {plan.name}
                        </button>
                    )
                )}
            </div>
        ))}
    </div>
);

interface BillingPanelProps {
    /** Members in the organisation — the real seat count, not the billed quantity. */
    memberCount: number;
    /** Open the provider's customer portal. */
    /** Open the provider's customer portal. The return is ignored. */
    onManage: () => unknown;
    plans: ReadonlyArray<Plan>;
    /** `undefined` while the query is in flight. */
    subscription: SubscriptionLike | undefined;
}

/** Current plan, seat usage, and the way out to the provider's portal. */
const BillingPanel = ({ memberCount, onManage, plans, subscription }: BillingPanelProps): ReactNode => {
    const plan = currentPlan(plans, subscription);
    const seats = seatUsage(plan, memberCount);
    const notice = subscriptionNotice(subscription);

    return (
        <Card
            actions={
                <button
                    className="lu-saas-button lu-saas-button--quiet"
                    onClick={() => {
                        onManage();
                    }}
                    type="button"
                >
                    Manage billing
                </button>
            }
            subtitle={plan?.name}
            title="Billing"
        >
            {notice ? (
                <p className="lu-saas-error" role="status">
                    {notice}
                </p>
            ) : undefined}
            <p>
                {seats.limit === undefined ? `${seats.used.toString()} members, unmetered` : `${seats.used.toString()} of ${seats.limit.toString()} seats used`}
            </p>
            {seats.limit === undefined ? undefined : (
                <progress className="lu-saas-meter" max={1} value={seats.ratio}>
                    {Math.round(seats.ratio * 100)}%
                </progress>
            )}
            {seats.over ? (
                <p className="lu-saas-error" role="alert">
                    This organization is over its seat allowance. Upgrade, or remove members.
                </p>
            ) : undefined}
        </Card>
    );
};

interface GatedProps {
    children: ReactNode;
    /** Shown instead of `children` when the tenant is not entitled. */
    fallback?: ReactNode;
    /** The capability name declared on a plan's `features`. */
    feature: string;
    plans: ReadonlyArray<Plan>;
    subscription: SubscriptionLike | undefined;
}

/**
 * Render `children` only when the tenant's plan includes `feature`.
 *
 * This decides what to RENDER, never what to allow — the mutation checks the
 * same entitlement server-side, because a gate a user can edit in devtools is a
 * suggestion. Showing the upsell instead of the feature is exactly what it is
 * for.
 */
const Gated = ({ children, fallback, feature, plans, subscription }: GatedProps): ReactNode =>
    isEntitled(plans, subscription, feature) ? children : (fallback ?? <Empty title={`Your plan does not include ${feature}.`} />);

export type { BillingPanelProps, GatedProps, PricingTableProps };
export { BillingPanel, Gated, PricingTable };
