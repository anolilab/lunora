import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import SignUpInvitationsPanel from "../../../src/features/auth/sign-up-invitations-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const HOUR_MS = 60 * 60 * 1000;

/** Rows as the admin plane returns them — timestamps are epoch-ms, `acceptedAt` null while unspent. */
const rows = (): Record<string, unknown>[] => [
    { acceptedAt: null, createdAt: Date.now(), email: "pending@example.com", expiresAt: Date.now() + HOUR_MS, id: "1", invitedBy: "owner" },
    { acceptedAt: Date.now(), createdAt: Date.now(), email: "spent@example.com", expiresAt: Date.now() + HOUR_MS, id: "2", invitedBy: null },
    { acceptedAt: null, createdAt: Date.now(), email: "dead@example.com", expiresAt: Date.now() - HOUR_MS, id: "3", invitedBy: null },
];

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <SignUpInvitationsPanel />
    </LunoraProvider>
);

describe("signUpInvitationsPanel", () => {
    it("labels each row from its own columns rather than asking the server", async () => {
        expect.assertions(3);

        const mock = createMockClient();

        mock.listAuthSignUpInvitations.mockResolvedValue({ rows: rows(), total: 3 });

        render(renderPanel(mock));

        // Status is derived client-side precisely so a page can mix all three.
        await waitFor(() => {
            expect(screen.getByTestId("sign-up-invitation-status-pending@example.com").textContent).toContain("Pending");
        });

        expect(screen.getByTestId("sign-up-invitation-status-spent@example.com").textContent).toContain("Accepted");
        expect(screen.getByTestId("sign-up-invitation-status-dead@example.com").textContent).toContain("Expired");
    });

    it("invites the typed address and re-reads the list", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        mock.listAuthSignUpInvitations.mockResolvedValue({ rows: [], total: 0 });

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("sign-up-invitations-empty").textContent).toContain("Nobody has been invited yet.");
        });

        fireEvent.change(screen.getByTestId("sign-up-invitation-email"), { target: { value: "  Ada@Example.com  " } });
        fireEvent.click(screen.getByTestId("sign-up-invitation-submit"));

        // Trimmed, but not lowercased here — normalizing is the server's job, and
        // doing it in two places is how the two drift.
        await waitFor(() => {
            expect(mock.createAuthSignUpInvitation).toHaveBeenCalledWith({ email: "Ada@Example.com" });
        });
    });

    it("shows the one-time link when the server returns a token", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        mock.listAuthSignUpInvitations.mockResolvedValue({ rows: [], total: 0 });
        mock.createAuthSignUpInvitation.mockResolvedValue({ email: "ada@example.com", id: "1", token: "tok_secret" });

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("sign-up-invitation-email"), { target: { value: "ada@example.com" } });
        fireEvent.click(screen.getByTestId("sign-up-invitation-submit"));

        await waitFor(() => {
            expect(screen.getByTestId<HTMLInputElement>("sign-up-invitation-link").value).toContain("invite=tok_secret");
        });

        // The address rides along so the invitee lands on a prefilled form.
        expect(screen.getByTestId<HTMLInputElement>("sign-up-invitation-link").value).toContain("email=ada%40example.com");
    });

    it("surfaces a rejected invite instead of silently clearing the field", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        mock.listAuthSignUpInvitations.mockResolvedValue({ rows: [], total: 0 });
        mock.createAuthSignUpInvitation.mockRejectedValue(new Error("not an email address to invite"));

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("sign-up-invitation-email"), { target: { value: "nope" } });
        fireEvent.click(screen.getByTestId("sign-up-invitation-submit"));

        await waitFor(() => {
            expect(screen.getByTestId("sign-up-invitations-error").textContent).toContain("not an email address to invite");
        });

        expect(screen.getByTestId<HTMLInputElement>("sign-up-invitation-email").value).toBe("nope");
    });

    it("revokes by address", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        mock.listAuthSignUpInvitations.mockResolvedValue({ rows: rows().slice(0, 1), total: 1 });

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("sign-up-invitation-pending@example.com").textContent).toContain("pending@example.com");
        });

        fireEvent.click(screen.getByText("Revoke"));

        await waitFor(() => {
            expect(mock.revokeAuthSignUpInvitation).toHaveBeenCalledWith({ email: "pending@example.com" });
        });
    });
});
