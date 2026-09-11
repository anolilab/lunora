import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Plan, SubscriptionLike } from "../../src/core";
import { BillingPanel, Gated, PricingTable } from "../../src/react/billing";

const PLANS: ReadonlyArray<Plan> = [
    { blurb: "Get going", currency: "USD", features: ["projects"], id: "free", name: "Free", priceMinor: 0, seats: 1 },
    { blurb: "For a team", currency: "USD", features: ["projects", "export"], id: "pro", name: "Pro", priceId: "price_pro", priceMinor: 2900, seats: 10 },
];

const active: SubscriptionLike = { cancelAtPeriodEnd: false, priceId: "price_pro", quantity: 5, state: "active" };

describe("pricingTable", () => {
    it("offers the plans you are not on and never the one you are", () => {
        const onSelect = vi.fn();

        render(<PricingTable onSelect={onSelect} plans={PLANS} subscription={undefined} />);

        expect(screen.getByText("Current plan")).toBeInTheDocument();

        fireEvent.click(screen.getByText("Choose Pro"));

        expect(onSelect).toHaveBeenCalledWith("price_pro");
    });

    it("does not offer a downgrade — that goes through the provider's portal", () => {
        render(<PricingTable onSelect={vi.fn()} plans={PLANS} subscription={active} />);

        expect(screen.queryByText("Choose Free")).not.toBeInTheDocument();
    });
});

describe("billingPanel", () => {
    it("counts members rather than the billed quantity", () => {
        render(<BillingPanel memberCount={8} onManage={vi.fn()} plans={PLANS} subscription={active} />);

        expect(screen.getByText("8 of 10 seats used")).toBeInTheDocument();
    });

    it("warns when the organization is over its allowance", () => {
        render(<BillingPanel memberCount={11} onManage={vi.fn()} plans={PLANS} subscription={active} />);

        expect(screen.getByRole("alert")).toHaveTextContent("over its seat allowance");
    });

    it("says what a failed payment means", () => {
        render(<BillingPanel memberCount={2} onManage={vi.fn()} plans={PLANS} subscription={{ ...active, state: "past_due" }} />);

        expect(screen.getByRole("status")).toHaveTextContent("update your card");
    });

    it("opens the provider's portal through the callback", () => {
        const onManage = vi.fn();

        render(<BillingPanel memberCount={2} onManage={onManage} plans={PLANS} subscription={active} />);
        fireEvent.click(screen.getByText("Manage billing"));

        expect(onManage).toHaveBeenCalled();
    });
});

describe("gated", () => {
    it("renders the feature when the plan includes it", () => {
        render(
            <Gated feature="export" plans={PLANS} subscription={active}>
                <p>Export</p>
            </Gated>,
        );

        expect(screen.getByText("Export")).toBeInTheDocument();
    });

    it("renders the upsell instead when it does not", () => {
        render(
            <Gated feature="export" plans={PLANS} subscription={undefined}>
                <p>Export</p>
            </Gated>,
        );

        expect(screen.queryByText("Export")).not.toBeInTheDocument();
        expect(screen.getByText("Your plan does not include export.")).toBeInTheDocument();
    });
});
