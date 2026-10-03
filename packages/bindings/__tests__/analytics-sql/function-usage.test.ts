import { afterEach, describe, expect, it, vi } from "vitest";

import { FUNCTION_USAGE_PANELS, functionUsageQuery, isFunctionUsagePanel } from "../../src/analytics-sql";

describe("functionUsageQuery", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(FUNCTION_USAGE_PANELS)("builds one bound, time-bounded statement for the %s panel", (panel) => {
        expect.assertions(4);

        const request = functionUsageQuery(panel, { dataset: "app", since: "2026-10-01T00:00:00.000Z" });

        expect(request.query).toContain('FROM events.analyticsEngine."app" WHERE timestamp >= $since');
        expect(request.query).toContain("blob1 = 'function_call'");
        // The Analytics SQL dialect: no Analytics Engine SQL API spellings.
        expect(request.query).not.toMatch(/_sample_interval|count\(\)/u);
        expect(request.params).toStrictEqual({ since: "2026-10-01T00:00:00.000Z" });
    });

    it("defaults the lower bound to 24 hours ago", () => {
        expect.assertions(1);

        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));

        expect(functionUsageQuery("volume").params.since).toBe("2026-10-02T12:00:00.000Z");
    });

    it("quotes the dataset as an identifier, doubling an embedded quote", () => {
        expect.assertions(1);

        expect(functionUsageQuery("hotShards", { dataset: 'odd"name' }).query).toContain('FROM events.analyticsEngine."odd""name"');
    });

    it("weights the latency quantiles by sampleInterval", () => {
        expect.assertions(1);

        expect(functionUsageQuery("latency").query).toContain("quantileWeighted(0.95, double1, sampleInterval)");
    });

    it("accepts only the panel keys", () => {
        expect.assertions(3);

        expect(isFunctionUsagePanel("volume")).toBe(true);
        expect(isFunctionUsagePanel("SELECT * FROM events.http_requests")).toBe(false);
        expect(isFunctionUsagePanel(undefined)).toBe(false);
    });
});
