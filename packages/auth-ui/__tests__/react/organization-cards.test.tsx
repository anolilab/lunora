import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse } from "../../src/core";
import { AuthUIProvider, OrganizationsCard, TwoFactorSetupCard } from "../../src/react";

const ok = <T,>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const stubClient = (overrides: Partial<Record<string, unknown>> = {}): AuthClient =>
    ({
        organization: {
            cancelInvitation: vi.fn(() => ok()),
            create: vi.fn(() => ok({ id: "org-2" })),
            delete: vi.fn(() => ok()),
            getFullOrganization: vi.fn(() => ok({ invitations: [], members: [] })),
            inviteMember: vi.fn(() => ok()),
            list: vi.fn(() => ok([{ id: "org-1", name: "Acme", slug: "acme" }])),
            removeMember: vi.fn(() => ok()),
            setActive: vi.fn(() => ok()),
            updateMemberRole: vi.fn(() => ok()),
        },
        twoFactor: {
            disable: vi.fn(() => ok()),
            enable: vi.fn(() => ok({ backupCodes: ["aaa"], totpURI: "otpauth://totp/x" })),
            verifyTotp: vi.fn(() => ok()),
        },
        ...overrides,
    }) as unknown as AuthClient;

const renderWith = (client: AuthClient, node: ReactElement): void => {
    render(
        <AuthUIProvider authClient={client} nav={{ navigate: vi.fn(), replace: vi.fn() }}>
            {node}
        </AuthUIProvider>,
    );
};

describe("organizationsCard", () => {
    it("lists organizations and creates a new one", async () => {
        const client = stubClient();
        renderWith(client, <OrganizationsCard />);

        await waitFor(() => {
            expect(screen.getByText("Acme")).toBeDefined();
        });

        fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "New Co" } });
        fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

        await waitFor(() => {
            expect(client.organization.create as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ name: "New Co", slug: "new-co" });
        });
    });
});

describe("twoFactorSetupCard", () => {
    it("enables 2FA, then shows the URI + backup codes on the verify step", async () => {
        const client = stubClient();
        renderWith(client, <TwoFactorSetupCard />);

        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
        fireEvent.click(screen.getByRole("button", { name: "Enable 2FA" }));

        await waitFor(() => {
            expect(screen.getByText("otpauth://totp/x")).toBeDefined();
            expect(screen.getByText("aaa")).toBeDefined();
        });
    });
});
