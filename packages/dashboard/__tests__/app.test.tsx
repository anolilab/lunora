import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { DashboardApp } from "../src/app.js";

const TOKEN_KEY = "cirrus-dashboard-admin-token";

describe("dashboardApp", () => {
    afterEach(() => {
        sessionStorage.clear();
    });

    test("renders the header and token input", () => {
        expect.assertions(2);

        render(<DashboardApp baseUrl="https://app.example" />);

        expect(screen.getByTestId("dash-app-header")).toBeDefined();
        expect(screen.getByTestId("dash-app-token")).toBeDefined();
    });

    test("renders the dashboard shell under the provider", () => {
        expect.assertions(1);

        render(<DashboardApp baseUrl="https://app.example" />);

        expect(screen.getByTestId("cirrus-dashboard")).toBeDefined();
    });

    test("shows the connection badge (idle without a live socket)", () => {
        expect.assertions(1);

        render(<DashboardApp baseUrl="https://app.example" />);

        expect(screen.getByTestId("dash-connection").dataset.status).toBe("idle");
    });

    test("persists the admin token to sessionStorage and restores it on remount", () => {
        expect.assertions(2);

        const { unmount } = render(<DashboardApp baseUrl="https://app.example" />);

        fireEvent.change(screen.getByTestId("dash-app-token"), { target: { value: "s3cret" } });

        expect(sessionStorage.getItem(TOKEN_KEY)).toBe("s3cret");

        unmount();
        render(<DashboardApp baseUrl="https://app.example" />);

        expect((screen.getByTestId("dash-app-token") as HTMLInputElement).value).toBe("s3cret");
    });

    test("clear removes the persisted token", () => {
        expect.assertions(2);

        sessionStorage.setItem(TOKEN_KEY, "s3cret");
        render(<DashboardApp baseUrl="https://app.example" />);

        expect((screen.getByTestId("dash-app-token") as HTMLInputElement).value).toBe("s3cret");

        fireEvent.click(screen.getByTestId("dash-app-clear-token"));

        expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });
});
