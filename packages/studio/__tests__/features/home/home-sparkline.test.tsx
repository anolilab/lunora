import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HomePanel } from "../../../src/features/home/home-panel";
import { sparklineBars } from "../../../src/features/home/sparkline";
import type { MetricsHistoryBucket } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";
import wrapInRouter from "../../render-with-router";

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

describe("home sparkline", () => {
    it("is not mounted while the metrics history is too short to draw", async () => {
        expect.assertions(2);

        renderHome(2);

        await expect(screen.findByText("Requests")).resolves.toBeDefined();
        expect(screen.queryAllByTestId("home-sparkline")).toHaveLength(0);
    });

    it("draws the requests and errors sparklines, hidden from assistive tech, once there are enough minute buckets", async () => {
        expect.assertions(2);

        renderHome(3);

        const sparklines = await screen.findAllByTestId("home-sparkline");

        expect(sparklines).toHaveLength(2);
        expect(sparklines.map((svg) => svg.getAttribute("aria-hidden"))).toStrictEqual(["true", "true"]);
    });

    it("scales bars to the series max inside the 5px plot margin", () => {
        expect.assertions(1);

        // 102px plot / 3 slots = 34px, minus a 1px gap per side; heights out of the
        // 22px plot, each trimmed 3px at the baseline.
        expect(sparklineBars([1, 2, 4])).toStrictEqual([
            { height: 2.5, width: 32, x: 6, y: 21.5 },
            { height: 8, width: 32, x: 40, y: 16 },
            { height: 19, width: 32, x: 74, y: 5 },
        ]);
    });

    it("keeps only the newest 16 points and draws nothing for an all-zero series", () => {
        expect.assertions(2);

        expect(sparklineBars(Array.from({ length: 20 }, (_, index) => index))).toHaveLength(16);
        expect(sparklineBars([0, 0, 0]).map((bar) => bar.height)).toStrictEqual([0, 0, 0]);
    });
});
