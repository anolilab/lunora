import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse } from "../../src/core";
import { AuthUIProvider, SessionsCard, SignOutButton } from "../../src/react";

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
