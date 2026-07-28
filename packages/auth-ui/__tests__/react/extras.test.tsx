import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { pushToast, resetToasts } from "../../src/core";
import { AuthUIProvider, ErrorToaster, OrganizationLogoCard } from "../../src/react";

const stubClient = (): AuthClient => ({ getSession: vi.fn() }) as unknown as AuthClient;

// eslint-disable-next-line vitest/require-top-level-describe -- one cross-suite teardown hook belongs at the top level.
afterEach(() => {
    resetToasts();
});

describe("errorToaster", () => {
    it("renders nothing until something fails", () => {
        expect.assertions(1);

        const { container } = render(<ErrorToaster />);

        expect(container.textContent).toBe("");
    });

    it("shows a pushed message and lets the user dismiss it", () => {
        expect.assertions(2);

        // Pushed before render: the store notifies outside React's act() scope,
        // and an unacted external-store update is exactly the warning-and-stale
        // -render combination this test would otherwise be asserting around.
        pushToast("Could not sign you in.");
        render(<ErrorToaster />);

        expect(screen.getByRole("status").textContent).toContain("Could not sign you in.");

        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

        expect(screen.queryByRole("status")).toBeNull();
    });
});

describe("organizationLogoCard", () => {
    it("renders nothing without an upload handler, since there is nowhere to put the bytes", () => {
        expect.assertions(1);

        const { container } = render(
            <AuthUIProvider authClient={stubClient()} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }} plugins={{ organization: true }}>
                <OrganizationLogoCard />
            </AuthUIProvider>,
        );

        expect(container.textContent).toBe("");
    });
});
