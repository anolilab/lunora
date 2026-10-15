import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { emptyUsageTotals } from "../src/billing/usage";
import { CostByProduct } from "../src/client/UsageSection";

/**
 * The Usage tab's per-product cost (issue #687): a product the platform does not
 * measure is named as not measured instead of reading as a zero bill, and a
 * measured meter that is alert-only says so.
 */

describe("the usage tab's cost by product", () => {
    it("names the unmeasured products even when nothing was used", () => {
        expect.hasAssertions();

        const html = renderToStaticMarkup(<CostByProduct totals={emptyUsageTotals()} />);

        expect(html).toContain("Not measured");
        expect(html).toContain("Workers KV");
        expect(html).toContain("A zero here is not a zero bill.");
    });

    it("marks an alert-only meter's line, and leaves an enforced one unmarked", () => {
        expect.hasAssertions();

        const totals = emptyUsageTotals();

        totals.cpuMs = 1_000_000;
        totals.requests = 1_000_000;

        const html = renderToStaticMarkup(<CostByProduct totals={totals} />);

        expect(html.match(/alert only/g)).toHaveLength(1);
        expect(html).toContain("Workers for Platforms · 1,000,000 CPU-millisecond · alert only");
    });
});
