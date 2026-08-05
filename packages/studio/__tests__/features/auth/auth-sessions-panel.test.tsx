import type { AuthPage, AuthSession } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import AuthSessionsPanel from "../../../src/features/auth/auth-sessions-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const SESSIONS: AuthSession[] = [
    { expiresAt: 1_700_000_000_000, id: "s1", impersonatedBy: null, ipAddress: "local-test-host", userAgent: "curl", userId: "u1" },
    { expiresAt: 1_700_000_001_000, id: "s2", impersonatedBy: "admin-1", ipAddress: "other-host", userAgent: "firefox", userId: "u2" },
];

const createSessionsClient = (): MockClientHooks =>
    createMockClient({
        listAuthSessions: (): AuthPage<AuthSession> => {
            return { rows: SESSIONS, total: SESSIONS.length };
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <AuthSessionsPanel />
    </LunoraProvider>
);

describe("authSessionsPanel", () => {
    it("lists all sessions across users on mount", async () => {
        expect.assertions(4);

        const mock = createSessionsClient();

        render(renderPanel(mock));

        await screen.findByTestId("auth-sessions-table");

        expect(mock.listAuthSessions).toHaveBeenCalledWith(expect.not.objectContaining({ userId: expect.anything() }));
        expect(screen.getByTestId("auth-session-s1").textContent).toContain("u1");
        expect(screen.getByTestId("auth-session-s1").textContent).toContain("curl");
        expect(screen.getByTestId("auth-session-s2").textContent).toContain("admin-1");
    });

    it("revokes a session and refetches", async () => {
        expect.assertions(2);

        const mock = createSessionsClient();

        render(renderPanel(mock));

        await screen.findByTestId("auth-sessions-table");

        const callsBefore = mock.listAuthSessions.mock.calls.length;

        fireEvent.click(screen.getByTestId("auth-session-revoke-s1"));

        await waitFor(() => {
            if (mock.revokeAuthSession.mock.calls.length === 0) {
                throw new Error("revoke not invoked yet");
            }
        });
        await waitFor(() => {
            if (mock.listAuthSessions.mock.calls.length <= callsBefore) {
                throw new Error("sessions not refetched yet");
            }
        });

        expect(mock.revokeAuthSession).toHaveBeenCalledWith({ sessionId: "s1" });
        expect(mock.listAuthSessions.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("shows an empty state when there are no sessions", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            listAuthSessions: (): AuthPage<AuthSession> => {
                return { rows: [], total: 0 };
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("auth-sessions-empty");

        expect(screen.getByTestId("auth-sessions-empty").textContent).toContain("No active sessions.");
    });

    it("surfaces a sessions-listing error", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.listAuthSessions.mockRejectedValueOnce(new Error("AUTH_NOT_CONFIGURED"));

        render(renderPanel(mock));

        const error = await screen.findByTestId("auth-sessions-error");

        expect(error.textContent).toBe("AUTH_NOT_CONFIGURED");
    });

    it("polls to re-list sessions on an interval (always on, no toggle)", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        try {
            const mock = createSessionsClient();

            render(renderPanel(mock));

            await vi.advanceTimersByTimeAsync(0);

            const callsAfterMount = mock.listAuthSessions.mock.calls.length;

            await vi.advanceTimersByTimeAsync(10_000);

            expect(mock.listAuthSessions.mock.calls.length).toBeGreaterThan(callsAfterMount);
        } finally {
            vi.useRealTimers();
        }
    });
});
