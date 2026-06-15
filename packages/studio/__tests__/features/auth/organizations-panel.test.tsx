import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { OrganizationsPanel } from "../../../src/features/auth/organizations-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <OrganizationsPanel />
    </LunoraProvider>
);

describe("organizationsPanel", () => {
    it("shows a disabled empty state when the organization plugin is off", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.getAuthCapabilities.mockResolvedValueOnce({ accounts: true, admin: true, organization: false, passkey: false, twoFactor: false });

        render(renderPanel(mock));

        await screen.findByTestId("org-disabled");

        expect(mock.listAuthOrganizations).not.toHaveBeenCalled();
    });

    it("lists organizations and loads members on demand when enabled", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        mock.getAuthCapabilities.mockResolvedValueOnce({ accounts: true, admin: true, organization: true, passkey: false, twoFactor: false });
        mock.listAuthOrganizations.mockResolvedValueOnce({ rows: [{ id: "org_1", name: "Acme", slug: "acme" }], total: 1 });
        mock.listAuthOrgMembers.mockResolvedValueOnce({ rows: [{ id: "mem_1", role: "owner", userId: "u1" }], total: 1 });

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("org-select-org_1"));

        await screen.findByTestId("org-member-mem_1");

        await waitFor(() => {
            expect(mock.listAuthOrgMembers).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_1" }));
        });

        expect(screen.getByTestId("org-row-org_1").textContent).toContain("Acme");
    });
});
