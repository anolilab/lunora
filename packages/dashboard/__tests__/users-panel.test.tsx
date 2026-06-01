import type { AuthPage, AuthSession, AuthUser } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";

import { UsersPanel } from "../src/users-panel.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const USERS: AuthUser[] = [
    { createdAt: 1, email: "a@example.com", emailVerified: true, id: "u1", name: "Ann" },
    { createdAt: 2, email: "b@example.com", emailVerified: false, id: "u2", name: "Bob" },
];

const SESSIONS: AuthSession[] = [{ expiresAt: 1_700_000_000_000, id: "s1", ipAddress: "local-test-host", userAgent: "curl", userId: "u1" }];

const createUsersClient = (): MockClientHooks =>
    createMockClient({
        listAuthSessions: (options): AuthPage<AuthSession> => {
            if (options.userId !== "u1") {
                return { rows: [], total: 0 };
            }

            return { rows: SESSIONS, total: SESSIONS.length };
        },
        listAuthUsers: (): AuthPage<AuthUser> => ({ rows: USERS, total: USERS.length }),
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <UsersPanel />
    </CirrusProvider>
);

describe("usersPanel", () => {
    test("lists users on mount", async () => {
        expect.assertions(2);

        render(renderPanel(createUsersClient()));

        await screen.findByTestId("us-table");

        expect(screen.getByTestId("us-row-u1").textContent).toContain("a@example.com");
        expect(screen.getByTestId("us-row-u2").textContent).toContain("Bob");
    });

    test("loads a user's sessions on demand", async () => {
        expect.assertions(2);

        const mock = createUsersClient();

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("us-sessions-u1"));

        await screen.findByTestId("us-session-s1");

        expect(mock.listAuthSessions).toHaveBeenCalledWith({ limit: 50, userId: "u1" });
        expect(screen.getByTestId("us-session-s1").textContent).toContain("curl");
    });

    test("shows an empty state for a user with no sessions", async () => {
        expect.assertions(1);

        const mock = createUsersClient();

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("us-sessions-u2"));

        const empty = await screen.findByTestId("us-sessions-empty");

        expect(empty).toBeDefined();
    });

    test("surfaces a users-listing error", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.listAuthUsers.mockRejectedValueOnce(new Error("AUTH_NOT_CONFIGURED"));

        render(renderPanel(mock));

        const error = await screen.findByTestId("us-users-error");

        expect(error.textContent).toBe("AUTH_NOT_CONFIGURED");
    });

    test("toggling Auto re-lists users on an interval", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        try {
            const mock = createUsersClient();

            render(renderPanel(mock));

            await vi.advanceTimersByTimeAsync(0);

            const callsAfterMount = mock.listAuthUsers.mock.calls.length;

            fireEvent.click(screen.getByTestId("us-auto"));

            await vi.advanceTimersByTimeAsync(10_000);

            expect(mock.listAuthUsers).toHaveBeenCalledTimes(callsAfterMount + 2);
        } finally {
            vi.useRealTimers();
        }
    });
});
