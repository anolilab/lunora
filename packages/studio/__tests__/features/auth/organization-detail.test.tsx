import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { OrganizationDetail } from "../../../src/features/auth/organization-detail";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const renderDetail = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <OrganizationDetail organizationId="org_1" rolesEnabled={false} teamsEnabled={false} />
    </LunoraProvider>
);

describe("organizationDetail row actions", () => {
    it("surfaces a rejected member-removal instead of silently discarding it", async () => {
        expect.assertions(3);

        const mock = createMockClient();

        mock.listAuthOrgMembers.mockResolvedValue({ rows: [{ id: "mem_1", role: "owner", userId: "u1" }], total: 1 });
        mock.removeAuthOrgMember.mockRejectedValueOnce(new Error("FORBIDDEN"));

        render(renderDetail(mock));

        fireEvent.click(await screen.findByTestId("org-remove-member-mem_1"));

        const error = await screen.findByTestId("org-action-error");

        expect(error.textContent).toBe("FORBIDDEN");
        // The row must not vanish/refetch away on a failed removal — it's still there.
        expect(screen.getByTestId("org-member-mem_1")).toBeTruthy();
        // A failed action must not refetch (which would mask the failure as a stale success).
        expect(mock.listAuthOrgMembers.mock.calls.length).toBe(1);
    });

    it("surfaces a rejected invitation-cancel", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.listAuthOrgInvitations.mockResolvedValue({ rows: [{ email: "a@example.com", id: "inv_1", role: "member", status: "pending" }], total: 1 });
        mock.cancelAuthOrgInvitation.mockRejectedValueOnce(new Error("NOT_FOUND"));

        render(renderDetail(mock));

        fireEvent.click(await screen.findByTestId("org-cancel-invitation-inv_1"));

        await waitFor(() => {
            expect(screen.getByTestId("org-action-error").textContent).toBe("NOT_FOUND");
        });
    });

    it("still refetches after a successful member removal (regression)", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.listAuthOrgMembers.mockResolvedValue({ rows: [{ id: "mem_1", role: "owner", userId: "u1" }], total: 1 });

        render(renderDetail(mock));

        const callsBefore = mock.listAuthOrgMembers.mock.calls.length;

        fireEvent.click(await screen.findByTestId("org-remove-member-mem_1"));

        await waitFor(() => {
            if (mock.listAuthOrgMembers.mock.calls.length <= callsBefore) {
                throw new Error("not refetched yet");
            }
        });

        expect(mock.listAuthOrgMembers.mock.calls.length).toBeGreaterThan(callsBefore);
    });
});
