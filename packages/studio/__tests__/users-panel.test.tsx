import type { AuthPage, AuthSession, AuthUser } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { UsersPanel } from "../src/users-panel";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const USERS: AuthUser[] = [
    { banned: false, createdAt: 1, email: "a@example.com", emailVerified: true, id: "u1", name: "Ann", role: "admin" },
    { banned: true, banReason: "spam", createdAt: 2, email: "b@example.com", emailVerified: false, id: "u2", name: "Bob", role: "user" },
];

const SESSIONS: AuthSession[] = [{ expiresAt: 1_700_000_000_000, id: "s1", ipAddress: "local-test-host", userAgent: "curl", userId: "u1" }];

const createUsersClient = (): MockClientHooks =>
    createMockClient({
        listAuthSessions: (options): AuthPage<AuthSession> => (options.userId === "u1" ? { rows: SESSIONS, total: SESSIONS.length } : { rows: [], total: 0 }),
        listAuthUsers: (): AuthPage<AuthUser> => {
            return { rows: USERS, total: USERS.length };
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <UsersPanel />
    </CirrusProvider>
);

describe("usersPanel", () => {
    it("lists users with role + status on mount", async () => {
        expect.assertions(3);

        render(renderPanel(createUsersClient()));

        await screen.findByTestId("us-table");

        expect(screen.getByTestId("us-row-u1").textContent).toContain("a@example.com");
        expect(screen.getByTestId("us-row-u1").textContent).toContain("admin");
        expect(screen.getByTestId("us-row-u2").textContent).toContain("Banned");
    });

    it("forwards a debounced search to listAuthUsers", async () => {
        expect.assertions(1);

        const mock = createUsersClient();

        render(renderPanel(mock));
        await screen.findByTestId("us-table");

        fireEvent.change(screen.getByTestId("us-search"), { target: { value: "ann" } });

        await waitFor(() => {
            if (!mock.listAuthUsers.mock.calls.some(([options]) => (options as { search?: string }).search === "ann")) {
                throw new Error("search not forwarded yet");
            }
        });

        expect(mock.listAuthUsers).toHaveBeenCalledWith(expect.objectContaining({ search: "ann" }));
    });

    it("forwards a role filter to listAuthUsers", async () => {
        expect.assertions(1);

        const mock = createUsersClient();

        render(renderPanel(mock));
        await screen.findByTestId("us-table");

        fireEvent.change(screen.getByTestId("us-role-filter"), { target: { value: "admin" } });

        await waitFor(() => {
            if (!mock.listAuthUsers.mock.calls.some(([options]) => (options as { filterValue?: string }).filterValue === "admin")) {
                throw new Error("role filter not forwarded yet");
            }
        });

        expect(mock.listAuthUsers).toHaveBeenCalledWith(expect.objectContaining({ filterField: "role", filterValue: "admin" }));
    });

    it("opens the detail drawer and loads the user's sessions", async () => {
        expect.assertions(2);

        const mock = createUsersClient();

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("us-manage-u1"));

        await screen.findByTestId("ud-session-s1");

        expect(mock.listAuthSessions).toHaveBeenCalledWith({ limit: 50, userId: "u1" });
        expect(screen.getByTestId("ud-session-s1").textContent).toContain("curl");
    });

    it("bans a user from the drawer and refetches", async () => {
        expect.assertions(2);

        const mock = createUsersClient();

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("us-manage-u1"));
        await screen.findByTestId("ud-panel");

        const callsBefore = mock.listAuthUsers.mock.calls.length;

        fireEvent.click(screen.getByTestId("ud-ban"));

        await waitFor(() => {
            if (mock.banAuthUser.mock.calls.length === 0) {
                throw new Error("ban not invoked yet");
            }
        });
        await waitFor(() => {
            if (mock.listAuthUsers.mock.calls.length <= callsBefore) {
                throw new Error("users not refetched yet");
            }
        });

        expect(mock.banAuthUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
        expect(mock.listAuthUsers.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("unbans an already-banned user from the drawer", async () => {
        expect.assertions(1);

        const mock = createUsersClient();

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("us-manage-u2"));
        fireEvent.click(await screen.findByTestId("ud-unban"));

        await waitFor(() => {
            if (mock.unbanAuthUser.mock.calls.length === 0) {
                throw new Error("unban not invoked yet");
            }
        });

        expect(mock.unbanAuthUser).toHaveBeenCalledWith({ userId: "u2" });
    });

    it("surfaces an impersonation token", async () => {
        expect.assertions(1);

        const mock = createUsersClient();

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("us-manage-u1"));
        fireEvent.click(await screen.findByTestId("ud-impersonate"));

        const token = await screen.findByTestId("ud-token");

        expect((token as HTMLInputElement).value).toBe("tok_u1");
    });

    it("creates a user via the dialog", async () => {
        expect.assertions(1);

        const mock = createUsersClient();

        render(renderPanel(mock));
        await screen.findByTestId("us-table");

        fireEvent.click(screen.getByTestId("us-new"));
        fireEvent.change(await screen.findByTestId("uc-email"), { target: { value: "c@example.com" } });
        fireEvent.change(screen.getByTestId("uc-name"), { target: { value: "Cara" } });
        fireEvent.click(screen.getByTestId("uc-submit"));

        await waitFor(() => {
            if (mock.createAuthUser.mock.calls.length === 0) {
                throw new Error("create not invoked yet");
            }
        });

        expect(mock.createAuthUser).toHaveBeenCalledWith(expect.objectContaining({ email: "c@example.com", name: "Cara" }));
    });

    it("surfaces a users-listing error", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.listAuthUsers.mockRejectedValueOnce(new Error("AUTH_NOT_CONFIGURED"));

        render(renderPanel(mock));

        const error = await screen.findByTestId("us-users-error");

        expect(error.textContent).toBe("AUTH_NOT_CONFIGURED");
    });

    it("toggling Auto re-lists users on an interval", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        try {
            const mock = createUsersClient();

            render(renderPanel(mock));

            await vi.advanceTimersByTimeAsync(0);

            const callsAfterMount = mock.listAuthUsers.mock.calls.length;

            fireEvent.click(screen.getByTestId("us-auto"));

            await vi.advanceTimersByTimeAsync(10_000);

            expect(mock.listAuthUsers.mock.calls.length).toBeGreaterThan(callsAfterMount);
        } finally {
            vi.useRealTimers();
        }
    });
});
