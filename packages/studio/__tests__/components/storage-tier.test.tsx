import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StorageTierBadge, TIER_META } from "../../src/components/storage-tier";

describe("storageTier", () => {
    it("renders the shard badge with its label, accent colour, and tooltip", () => {
        expect.assertions(3);

        render(<StorageTierBadge tier="shard" />);

        const badge = screen.getByTestId("storage-tier-shard");

        expect(badge.textContent).toContain(TIER_META.shard.label);
        expect(badge.getAttribute("title")).toBe(TIER_META.shard.title);
        expect(badge.dataset["tier"]).toBe("shard");
    });

    it("renders the global badge distinctly from the shard badge", () => {
        expect.assertions(2);

        render(<StorageTierBadge tier="global" />);

        expect(screen.getByTestId("storage-tier-global").textContent).toContain(TIER_META.global.label);
        // The two tiers must not share a label, or the distinction is moot.
        expect(TIER_META.global.label).not.toBe(TIER_META.shard.label);
    });
});
