import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { Plan, SubscriptionLike } from "../../src/core";
import BillingPanel from "../../src/svelte/BillingPanel.svelte";
import PricingTable from "../../src/svelte/PricingTable.svelte";

/** The same behaviours as the React suite, against the same core. */

const PLANS: ReadonlyArray<Plan> = [
    { blurb: "Get going", currency: "USD", features: ["projects"], id: "free", name: "Free", priceMinor: 0, seats: 1 },
    { blurb: "For a team", currency: "USD", features: ["projects", "export"], id: "pro", name: "Pro", priceId: "price_pro", priceMinor: 2900, seats: 10 },
];

const active: SubscriptionLike = { cancelAtPeriodEnd: false, priceId: "price_pro", quantity: 5, state: "active" };

describe("pricingTable", () => {
    it("offers the plans you are not on and never the one you are", async () => {
        const onSelect = vi.fn();

        render(PricingTable, { onSelect, plans: PLANS, subscription: undefined });

        expect(screen.getByText("Current plan")).toBeInTheDocument();

        await fireEvent.click(screen.getByText("Choose Pro"));

        expect(onSelect).toHaveBeenCalledWith("price_pro");
    });

    it("does not offer a downgrade", () => {
        render(PricingTable, { onSelect: vi.fn(), plans: PLANS, subscription: active });

        expect(screen.queryByText("Choose Free")).not.toBeInTheDocument();
    });
});

describe("billingPanel", () => {
    it("counts members rather than the billed quantity", () => {
        render(BillingPanel, { memberCount: 8, onManage: vi.fn(), plans: PLANS, subscription: active });

        expect(screen.getByText("8 of 10 seats used")).toBeInTheDocument();
    });

    it("warns when the organization is over its allowance", () => {
        render(BillingPanel, { memberCount: 11, onManage: vi.fn(), plans: PLANS, subscription: active });

        expect(screen.getByRole("alert")).toHaveTextContent("over its seat allowance");
    });

    it("opens the provider's portal through the callback", async () => {
        const onManage = vi.fn();

        render(BillingPanel, { memberCount: 2, onManage, plans: PLANS, subscription: active });
        await fireEvent.click(screen.getByText("Manage billing"));

        expect(onManage).toHaveBeenCalled();
    });
});
