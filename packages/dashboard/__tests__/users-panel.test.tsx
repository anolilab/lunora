import type { AuthPage, AuthSession, AuthUser } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";

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
        render(renderPanel(createUsersClient()));

        await waitFor(() => {
            expect(screen.getByTestId("us-table")).toBeDefined();
        });

        expect(screen.getByTestId("us-row-u1").textContent).toContain("a@example.com");
        expect(screen.getByTestId("us-row-u2").textContent).toContain("Bob");
    });

    test("loads a user's sessions on demand", async () => {
        const mock = createUsersClient();

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("us-sessions-u1")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("us-sessions-u1"));

        await waitFor(() => {
            expect(screen.getByTestId("us-session-s1")).toBeDefined();
        });

        expect(mock.listAuthSessions).toHaveBeenCalledWith({ limit: 50, userId: "u1" });
        expect(screen.getByTestId("us-session-s1").textContent).toContain("curl");
    });

    test("shows an empty state for a user with no sessions", async () => {
        const mock = createUsersClient();

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("us-sessions-u2")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("us-sessions-u2"));

        await waitFor(() => {
            expect(screen.getByTestId("us-sessions-empty")).toBeDefined();
        });
    });

    test("surfaces a users-listing error", async () => {
        const mock = createMockClient();

        mock.listAuthUsers.mockRejectedValueOnce(new Error("AUTH_NOT_CONFIGURED"));

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("us-users-error").textContent).toBe("AUTH_NOT_CONFIGURED");
        });
    });
});
