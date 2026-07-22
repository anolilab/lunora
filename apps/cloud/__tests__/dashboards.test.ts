import { describe, expect, it } from "vitest";

import type { DashboardPanel, MetricSeriesLike } from "../src/telemetry/dashboards";
import {
    addPanel,
    createPanel,
    isMetricPanel,
    movePanel,
    normalizePanelConfig,
    PANEL_KIND_LABELS,
    removePanel,
    statValue,
    validatePanel,
    validatePanels,
} from "../src/telemetry/dashboards";

const panel = (id: string, overrides: Partial<DashboardPanel> = {}): DashboardPanel => ({
    config: { metricName: "requests" },
    id,
    kind: "metric",
    title: id,
    ...overrides,
});

describe("panel reducers", () => {
    it("appends a panel immutably", () => {
        const before: DashboardPanel[] = [panel("a")];
        const after = addPanel(before, panel("b"));

        expect(after.map((p) => p.id)).toStrictEqual(["a", "b"]);
        expect(before).toHaveLength(1);
    });

    it("removes a panel by id, and is a no-op for an unknown id", () => {
        const panels = [panel("a"), panel("b"), panel("c")];

        expect(removePanel(panels, "b").map((p) => p.id)).toStrictEqual(["a", "c"]);
        expect(removePanel(panels, "zzz").map((p) => p.id)).toStrictEqual(["a", "b", "c"]);
    });

    it("moves a panel up and down by swapping with its neighbor", () => {
        const panels = [panel("a"), panel("b"), panel("c")];

        expect(movePanel(panels, "b", "up").map((p) => p.id)).toStrictEqual(["b", "a", "c"]);
        expect(movePanel(panels, "b", "down").map((p) => p.id)).toStrictEqual(["a", "c", "b"]);
    });

    it("clamps a move at the ends and no-ops an unknown id", () => {
        const panels = [panel("a"), panel("b")];

        expect(movePanel(panels, "a", "up").map((p) => p.id)).toStrictEqual(["a", "b"]);
        expect(movePanel(panels, "b", "down").map((p) => p.id)).toStrictEqual(["a", "b"]);
        expect(movePanel(panels, "zzz", "up").map((p) => p.id)).toStrictEqual(["a", "b"]);
    });

    it("does not mutate the input array when moving", () => {
        const panels = [panel("a"), panel("b")];

        movePanel(panels, "a", "down");
        expect(panels.map((p) => p.id)).toStrictEqual(["a", "b"]);
    });
});

describe(normalizePanelConfig, () => {
    it("keeps only the metric name for a metric panel", () => {
        expect(normalizePanelConfig("metric", { filter: "x", metricName: "requests", stat: "count" })).toStrictEqual({ metricName: "requests" });
        expect(normalizePanelConfig("metric", { metricName: "" })).toStrictEqual({});
    });

    it("always defines a stat aggregation for a stat panel", () => {
        expect(normalizePanelConfig("stat", { metricName: "requests" })).toStrictEqual({ metricName: "requests", stat: "last" });
        expect(normalizePanelConfig("stat", { metricName: "requests", stat: "count" })).toStrictEqual({ metricName: "requests", stat: "count" });
    });

    it("keeps only a trimmed non-empty filter for a shortcut panel", () => {
        expect(normalizePanelConfig("traces", { filter: "  status:error  ", metricName: "requests" })).toStrictEqual({ filter: "status:error" });
        expect(normalizePanelConfig("logs", { filter: "   " })).toStrictEqual({});
    });
});

describe(createPanel, () => {
    it("normalizes config to the kind and falls back to the kind label when the title is blank", () => {
        const built = createPanel({ config: { filter: "drop", metricName: "requests" }, id: "p1", kind: "stat", title: "  " });

        expect(built).toStrictEqual({ config: { metricName: "requests", stat: "last" }, id: "p1", kind: "stat", title: PANEL_KIND_LABELS.stat });
    });

    it("trims a provided title", () => {
        expect(createPanel({ config: {}, id: "p2", kind: "logs", title: "  Errors " }).title).toBe("Errors");
    });
});

describe(validatePanel, () => {
    it("requires a metric name for metric and stat panels", () => {
        expect(validatePanel(panel("a", { config: {} }))).toMatch(/needs a metric name/);
        expect(validatePanel(panel("a", { config: { metricName: "requests" } }))).toBeNull();
        expect(validatePanel(panel("a", { config: {}, kind: "stat" }))).toMatch(/needs a metric name/);
    });

    it("accepts shortcut panels with or without a filter", () => {
        expect(validatePanel(panel("a", { config: {}, kind: "traces" }))).toBeNull();
        expect(validatePanel(panel("a", { config: { filter: "x" }, kind: "logs" }))).toBeNull();
    });

    it("validatePanels returns the first offending panel's error", () => {
        expect(validatePanels([panel("ok"), panel("bad", { config: {} })])).toMatch(/needs a metric name/);
        expect(validatePanels([panel("ok"), panel("also-ok", { config: {}, kind: "traces" })])).toBeNull();
    });
});

describe(isMetricPanel, () => {
    it("is true only for metric and stat kinds", () => {
        expect(isMetricPanel("metric")).toBe(true);
        expect(isMetricPanel("stat")).toBe(true);
        expect(isMetricPanel("traces")).toBe(false);
        expect(isMetricPanel("logs")).toBe(false);
    });
});

describe(statValue, () => {
    const series: MetricSeriesLike[] = [{ firstValue: 10, lastValue: 42, name: "requests", points: [1, 2, 3] }];

    it("reduces the named series per aggregation", () => {
        expect(statValue(series, panel("a", { config: { metricName: "requests", stat: "last" } }))).toBe(42);
        expect(statValue(series, panel("a", { config: { metricName: "requests", stat: "first" } }))).toBe(10);
        expect(statValue(series, panel("a", { config: { metricName: "requests", stat: "count" } }))).toBe(3);
    });

    it("defaults to the last value when no aggregation is set", () => {
        expect(statValue(series, panel("a", { config: { metricName: "requests" } }))).toBe(42);
    });

    it("is undefined when the panel has no metric name or the series is absent", () => {
        expect(statValue(series, panel("a", { config: {} }))).toBeUndefined();
        expect(statValue(series, panel("a", { config: { metricName: "missing" } }))).toBeUndefined();
    });
});
