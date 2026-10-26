import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HomePanel } from "../../../src/features/home/home-panel";
import type { MetricsHistoryBucket } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";
import wrapInRouter from "../../render-with-router";

// The factory only runs when Home's lazy `import("./sparkline")` fires, so the
// counter records whether the chart chunk (recharts) was requested at all.
const sparklineLoads = vi.hoisted(() => {
    return { count: 0 };
});

vi.mock(import("../../../src/features/home/sparkline"), () => {
    sparklineLoads.count += 1;

    return { default: () => <div data-testid="home-sparkline" /> };
});

const renderHome = (minutes: number) => {
    const history: MetricsHistoryBucket[] = Array.from({ length: minutes }, (_, index) => {
        return { bucketMs: index * 60_000, calls: 5, errors: 1, path: "messages:send" };
    });
    const mock = createMockClient({
        query: (reference): unknown => (reference === ADMIN_FUNCTIONS.getMetrics ? { errors: 1, history, requests: 5 } : undefined),
    });

    return render(
        wrapInRouter(
            <LunoraProvider client={mock.asClient}>
                <HomePanel />
            </LunoraProvider>,
        ),
    );
};

describe("home sparkline loading", () => {
    it("never requests the chart chunk while the metrics history is too short to draw", async () => {
        expect.assertions(2);

        renderHome(2);

        await expect(screen.findByText("Requests")).resolves.toBeDefined();
        expect(sparklineLoads.count).toBe(0);
    });

    it("loads and draws the sparkline once there are enough minute buckets", async () => {
        expect.assertions(1);

        renderHome(3);

        await expect(screen.findAllByTestId("home-sparkline")).resolves.toHaveLength(2);
    });
});
