import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { DashboardApp } from "../src/app.js";

describe("dashboardApp", () => {
    test("renders the composed dashboard with every tab", () => {
        expect.assertions(12);

        render(<DashboardApp baseUrl="https://app.example" />);

        expect(screen.getByTestId("cirrus-dashboard-app")).toBeDefined();
        expect(screen.getByTestId("cirrus-dashboard")).toBeDefined();

        for (const tab of ["data", "globals", "schema", "functions", "migrations", "export", "files", "schedule", "users", "metrics"]) {
            expect(screen.getByTestId(`dash-tab-${tab}`)).toBeDefined();
        }
    });

    test("exposes an admin-token field that accepts input", () => {
        expect.assertions(2);

        render(<DashboardApp baseUrl="https://app.example" />);

        const input = screen.getByTestId("dash-app-token") as HTMLInputElement;

        expect(input.value).toBe("");

        fireEvent.change(input, { target: { value: "s3cret" } });

        expect(input.value).toBe("s3cret");
    });

    test("pre-fills the admin token when one is supplied", () => {
        expect.assertions(1);

        render(<DashboardApp adminToken="preset" baseUrl="https://app.example" />);

        expect((screen.getByTestId("dash-app-token") as HTMLInputElement).value).toBe("preset");
    });
});
