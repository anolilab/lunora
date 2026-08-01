import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse } from "../../src/core";
import { resetFlowWarnings } from "../../src/core";
import { AuthUIProvider, ChangePasswordCard, SessionsCard, SignOutButton } from "../../src/react";

const ok = <T,>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const stubClient = (overrides: Partial<Record<string, unknown>> = {}): AuthClient =>
    ({
        listSessions: vi.fn(() => ok([{ id: "s1", token: "tok-1", userAgent: "Chrome on macOS" }])),
        revokeOtherSessions: vi.fn(() => ok({ status: true })),
        revokeSession: vi.fn(() => ok({ status: true })),
        signOut: vi.fn(() => ok({ success: true })),
        ...overrides,
    }) as unknown as AuthClient;

const renderWith = (client: AuthClient, node: ReactElement): { nav: { navigate: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> } } => {
    const nav = { navigate: vi.fn(), replace: vi.fn() };

    render(
        <AuthUIProvider authClient={client} nav={nav} redirects={{ afterSignOut: "/bye" }}>
            {node}
        </AuthUIProvider>,
    );

    return { nav };
};

// One cross-suite teardown hook, deliberately at the top level.
afterEach(() => {
    resetFlowWarnings();
});

describe("sessionsCard", () => {
    it("loads and lists the active sessions, then revokes one", async () => {
        const client = stubClient();
        renderWith(client, <SessionsCard />);

        await waitFor(() => {
            expect(screen.getByText("Chrome on macOS")).toBeDefined();
        });

        fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

        await waitFor(() => {
            expect(client.revokeSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ token: "tok-1" });
        });
    });
});

describe("heading levels in a composed settings page", () => {
    it("renders card titles as h2, not h1 — the host settings page owns the h1", async () => {
        expect.assertions(2);

        const client = stubClient();

        renderWith(
            client,
            <>
                <SessionsCard />
                <ChangePasswordCard />
            </>,
        );

        await waitFor(() => {
            expect(screen.getByText("Chrome on macOS")).toBeDefined();
        });

        // Regression: every `AuthCard` hardcoded `<h1>`, so a settings page
        // stacking several cards broke the WCAG 1.3.1 heading outline a
        // screen-reader user navigates by.
        expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    });
});

describe("signOutButton", () => {
    it("signs out and navigates to the sign-out target", async () => {
        const client = stubClient();
        const { nav } = renderWith(client, <SignOutButton />);

        fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

        await waitFor(() => {
            expect(nav.replace).toHaveBeenCalledWith("/bye");
        });

        expect(client.signOut as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
});
