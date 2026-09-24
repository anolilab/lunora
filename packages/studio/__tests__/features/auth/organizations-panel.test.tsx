import type { AuthConfigInfo } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import OrganizationsPanel from "../../../src/features/auth/organizations-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/** An `AuthConfigInfo` with the organization plugin toggled on/off — the panel gates on `config.capabilities.organization`. */
const authConfig = (organization: boolean): AuthConfigInfo => {
    return {
        capabilities: { accounts: true, admin: true, inviteOnly: false, organization, passkey: false, twoFactor: false },
        emailAndPassword: true,
        organization: { enabled: organization, roles: false, teams: false },
        plugins: organization ? ["organization"] : [],
        rateLimit: { enabled: false },
        session: {},
        socialProviders: [],
        userFields: [],
    };
};

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <OrganizationsPanel />
    </LunoraProvider>
);

describe("organizationsPanel", () => {
    it("shows a disabled empty state when the organization plugin is off", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.getAuthConfig.mockResolvedValue(authConfig(false));

        render(renderPanel(mock));

        await screen.findByTestId("org-disabled");

        expect(mock.listAuthOrganizations).not.toHaveBeenCalled();
    });

    it("lists organizations and loads members on demand when enabled", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.getAuthConfig.mockResolvedValue(authConfig(true));
        mock.listAuthOrganizations.mockResolvedValue({ rows: [{ id: "org_1", name: "Acme", slug: "acme" }], total: 1 });
        mock.listAuthOrgMembers.mockResolvedValueOnce({ rows: [{ id: "mem_1", role: "owner", userId: "u1" }], total: 1 });

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("org-select-org_1"));

        await screen.findByTestId("org-member-mem_1");

        await waitFor(() => {
            expect(mock.listAuthOrgMembers).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_1" }));
        });

        expect(screen.getByTestId("org-row-org_1").textContent).toContain("Acme");
    });

    it("creates an organization via the new-organization dialog", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.getAuthConfig.mockResolvedValue(authConfig(true));
        mock.listAuthOrganizations.mockResolvedValue({ rows: [], total: 0 });

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("org-new"));
        fireEvent.change(await screen.findByTestId("org-form-name"), { target: { value: "Globex" } });
        fireEvent.click(screen.getByTestId("org-form-submit"));

        await waitFor(() => {
            if (mock.createAuthOrganization.mock.calls.length === 0) {
                throw new Error("create not invoked yet");
            }
        });

        expect(mock.createAuthOrganization).toHaveBeenCalledWith(expect.objectContaining({ name: "Globex" }));
    });

    it("adds a member to the selected organization", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.getAuthConfig.mockResolvedValue(authConfig(true));
        mock.listAuthOrganizations.mockResolvedValue({ rows: [{ id: "org_1", name: "Acme", slug: "acme" }], total: 1 });

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("org-select-org_1"));
        fireEvent.click(await screen.findByTestId("org-open-add-member"));
        fireEvent.change(await screen.findByTestId("org-add-member-user"), { target: { value: "u_42" } });
        fireEvent.click(screen.getByTestId("org-add-member-submit"));

        await waitFor(() => {
            if (mock.addAuthOrgMember.mock.calls.length === 0) {
                throw new Error("add not invoked yet");
            }
        });

        expect(mock.addAuthOrgMember).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org_1", userId: "u_42" }));
    });
});
