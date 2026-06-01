import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { DashboardApp } from "../src/app.js";
import { DashboardStyles } from "../src/theme.js";
import { DASHBOARD_ROOT_CLASS } from "../src/theme-constants.js";

describe("dashboard theme", () => {
    test("dashboardApp applies the scoped root class and injects the stylesheet", () => {
        expect.assertions(2);

        render(<DashboardApp baseUrl="https://app.example" />);

        expect(screen.getByTestId("cirrus-dashboard-app").classList.contains(DASHBOARD_ROOT_CLASS)).toBe(true);
        expect(screen.getByTestId("dash-styles")).toBeDefined();
    });

    test("every CSS selector is scoped under the root class", () => {
        expect.assertions(2);

        render(<DashboardStyles />);

        const css = screen.getByTestId("dash-styles").innerHTML;

        expect(css).toContain(`.${DASHBOARD_ROOT_CLASS}`);

        // Strip comments, drop declaration bodies and `@media {` wrappers, then
        // split each rule's selector group on commas: every individual selector
        // must carry the root class, so nothing leaks into a host page.
        const leaked = css
            .replaceAll(/\/\*[\s\S]*?\*\//g, "")
            .replaceAll(/\{[^{}]*\}/g, "|") // collapse declaration blocks to a delimiter
            .split(/[|{}]/u)
            .flatMap((group) => group.split(","))
            .map((selector) => selector.trim())
            .filter((selector) => selector !== "" && !selector.startsWith("@"))
            .filter((selector) => !selector.includes(`.${DASHBOARD_ROOT_CLASS}`));

        expect(leaked).toEqual([]);
    });
});
