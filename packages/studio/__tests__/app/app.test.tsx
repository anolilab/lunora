import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StudioApp } from "../../src/app/app";

const TOKEN_KEY = "lunora-studio-admin-token";

describe("studioApp", () => {
    afterEach(() => {
        sessionStorage.clear();
        localStorage.clear();
    });

    it("renders the header and token input", async () => {
        expect.assertions(2);

        render(<StudioApp baseUrl="https://app.example" />);

        // The header + sidebar chrome render inside the router's root route, which
        // resolves its first match a tick after mount — await rather than query sync.
        await expect(screen.findByTestId("dash-app-header")).resolves.toBeDefined();
        expect(screen.getByTestId("dash-app-token")).toBeDefined();
    });

    it("renders the studio shell under the provider", async () => {
        expect.assertions(1);

        render(<StudioApp baseUrl="https://app.example" />);

        await expect(screen.findByTestId("lunora-studio")).resolves.toBeDefined();
    });

    it("reflects the disconnected state in the sidebar connect control", async () => {
        expect.assertions(1);

        render(<StudioApp baseUrl="https://app.example" />);

        // Connection state lives on the sidebar footer profile/connect control
        // (no admin token supplied here, so it reads "Not connected").
        const connect = await screen.findByTestId("dash-app-connect");

        expect(connect.textContent).toContain("Not connected");
    });

    it("persists the admin token to sessionStorage and restores it on remount", async () => {
        expect.assertions(2);

        const { unmount } = render(<StudioApp baseUrl="https://app.example" />);

        fireEvent.change(await screen.findByTestId("dash-app-token"), { target: { value: "s3cret" } });

        expect(sessionStorage.getItem(TOKEN_KEY)).toBe("s3cret");

        unmount();
        render(<StudioApp baseUrl="https://app.example" />);

        const tokenInput = await screen.findByTestId<HTMLInputElement>("dash-app-token");

        expect(tokenInput.value).toBe("s3cret");
    });

    it("shows the rules banner only when rulesInstalled is false", async () => {
        expect.assertions(2);

        const { unmount } = render(<StudioApp baseUrl="https://app.example" />);

        await screen.findByTestId("dash-app-header");

        expect(screen.queryByTestId("dash-app-rules-banner")).toBeNull();

        unmount();
        render(<StudioApp baseUrl="https://app.example" rulesInstalled={false} />);

        await expect(screen.findByTestId("dash-app-rules-banner")).resolves.toBeDefined();
    });

    it("dismisses the rules banner and remembers it across remounts", async () => {
        expect.assertions(2);

        const { unmount } = render(<StudioApp baseUrl="https://app.example" rulesInstalled={false} />);

        fireEvent.click(await screen.findByTestId("dash-app-rules-banner-dismiss"));

        expect(screen.queryByTestId("dash-app-rules-banner")).toBeNull();

        unmount();
        render(<StudioApp baseUrl="https://app.example" rulesInstalled={false} />);

        await screen.findByTestId("dash-app-header");

        expect(screen.queryByTestId("dash-app-rules-banner")).toBeNull();
    });

    it("clear removes the persisted token", async () => {
        expect.assertions(2);

        sessionStorage.setItem(TOKEN_KEY, "s3cret");
        render(<StudioApp baseUrl="https://app.example" />);

        const tokenInput = await screen.findByTestId<HTMLInputElement>("dash-app-token");

        expect(tokenInput.value).toBe("s3cret");

        fireEvent.click(screen.getByTestId("dash-app-clear-token"));

        expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });
});
