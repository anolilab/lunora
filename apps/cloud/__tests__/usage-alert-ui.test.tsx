import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { suggestionLine, USAGE_METER_CHOICES, usageCondition, usageProgressLine, usageThresholdValue } from "../src/client/usage-alert";
import type { UsageRuleDraft } from "../src/client/UsageRuleFields";
import { UsageRuleFields } from "../src/client/UsageRuleFields";
import type { UsageThresholdSuggestion } from "../src/telemetry/usage-alerts";

/**
 * The Alerts tab's monthly usage rule, without a DOM: the suggestion the form
 * pre-fills and explains, a typed threshold winning over it, and the rule
 * list's month-to-date against the threshold.
 */

const JUNE = Date.UTC(2026, 5, 1);

const suggestion = (overrides: Partial<UsageThresholdSuggestion> = {}): UsageThresholdSuggestion => {
    return { basis: "history", lastMonth: 1_234_567, meter: "requests", periodStart: JUNE, suggested: 3_700_000, unit: "requests", ...overrides };
};

const draft = (overrides: Partial<UsageRuleDraft> = {}): UsageRuleDraft => {
    return {
        args: { meter: "requests", threshold: 3_700_000 },
        meter: "requests",
        projectId: undefined,
        projects: [],
        setMeter: () => undefined,
        setProjectId: () => undefined,
        setThreshold: () => undefined,
        suggestion: suggestion(),
        threshold: "3700000",
        ...overrides,
    };
};

describe("the usage rule form", () => {
    it("offers every metered meter, each with its unit", () => {
        expect.hasAssertions();

        expect(USAGE_METER_CHOICES.map((choice) => [choice.value, choice.unit])).toStrictEqual([
            ["requests", "requests"],
            ["cpuMs", "CPU ms"],
            ["d1RowsRead", "rows"],
            ["d1RowsWritten", "rows"],
            ["doRequests", "requests"],
            ["doDurationGbS", "GB-s"],
            ["doRowsRead", "rows"],
            ["doRowsWritten", "rows"],
        ]);
    });

    it("pre-fills the suggestion until something is typed, and never lets the suggestion overwrite what was typed", () => {
        expect.hasAssertions();

        expect(usageThresholdValue(null, undefined)).toBe("");
        expect(usageThresholdValue(null, suggestion())).toBe("3700000");
        expect(usageThresholdValue("2000000", suggestion())).toBe("2000000");
        expect(usageThresholdValue("", suggestion())).toBe("");
    });

    it("explains the suggestion by last month, by the floor, and when there is no history", () => {
        expect.hasAssertions();

        expect(suggestionLine(undefined)).toBeUndefined();
        expect(suggestionLine(suggestion())).toBe("Last month (June): 1,234,567 requests — suggested 3,700,000, 3× last month.");
        expect(suggestionLine(suggestion({ basis: "floor", lastMonth: 20, suggested: 1_000_000 }))).toBe(
            "Last month (June): 20 requests — suggested 1,000,000 requests, the minimum suggested for this meter.",
        );
        expect(suggestionLine(suggestion({ basis: "floor", lastMonth: null, meter: "cpuMs", suggested: 10_000_000, unit: "CPU ms" }))).toBe(
            "No CPU ms recorded in June — suggested 10,000,000 CPU ms, the minimum suggested for this meter.",
        );
        expect(suggestionLine(suggestion(), true)).toContain("Last month is the whole organization's usage.");
    });

    it("renders the meter, the unit, the pre-filled threshold and last month", () => {
        expect.hasAssertions();

        const markup = renderToStaticMarkup(<UsageRuleFields draft={draft()} />);

        expect(markup).toContain(">Workers requests</span>");
        expect(markup).toContain(">Whole organization</span>");
        expect(markup).toContain("Alert when this month passes (requests)");
        expect(markup).toContain('value="3700000"');
        expect(markup).toContain("Last month (June): 1,234,567 requests");

        const cpu = renderToStaticMarkup(
            <UsageRuleFields
                draft={draft({
                    meter: "cpuMs",
                    projectId: "prj_shop" as never,
                    projects: [{ _id: "prj_shop" as never, name: "Shop" }],
                    suggestion: undefined,
                    threshold: "",
                })}
            />,
        );

        expect(cpu).toContain(">Workers CPU time</span>");
        expect(cpu).toContain(">Shop</span>");
        expect(cpu).toContain("Alert when this month passes (CPU ms)");
        expect(cpu).not.toContain("Last month");
    });
});

describe("the usage rule list", () => {
    it("reads a rule as its meter and monthly quantity", () => {
        expect.hasAssertions();

        expect(usageCondition("requests", 2_000_000)).toBe("Workers requests ≥ 2,000,000 requests / month");
        expect(usageCondition("doDurationGbS", 400_000)).toBe("Durable Objects duration ≥ 400,000 GB-s / month");
    });

    it("shows this month's usage against the threshold", () => {
        expect.hasAssertions();

        expect(usageProgressLine(1_234_567, 2_000_000)).toBe("1,234,567 this month · 61%");
        expect(usageProgressLine(2_500_000.456, 2_000_000)).toBe("2,500,000.46 this month · 125%");
        expect(usageProgressLine(0, 2_000_000)).toBe("0 this month · 0%");
        expect(usageProgressLine(1_000_000, 2_000_000, false)).toBe("at least 1,000,000 this month · ≥50% (partial read)");
    });
});
