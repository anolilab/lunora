import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse } from "../../src/core";
import { resetFlowWarnings } from "../../src/core";
import { AuthUIProvider, OrganizationsCard, TwoFactorSetupCard } from "../../src/react";

const ok = <T,>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const OTPAUTH_URI_PATTERN = /^otpauth:\/\//u;

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
            // eslint-disable-next-line no-secrets/no-secrets -- a fake TOTP secret for the setup-card fixture, not a real credential
            enable: vi.fn(() => ok({ backupCodes: ["aaa"], totpURI: "otpauth://totp/Acme:ada?secret=JBSWY3DPEHPK3PXP&issuer=Acme" })),
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

// One cross-suite teardown hook, deliberately at the top level.
afterEach(() => {
    resetFlowWarnings();
});

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
    it("enables 2FA, then shows the setup key + backup codes on the verify step", async () => {
        const client = stubClient();
        renderWith(client, <TwoFactorSetupCard />);

        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
        fireEvent.click(screen.getByRole("button", { name: "Enable 2FA" }));

        await waitFor(() => {
            // The setup key, not the raw otpauth:// URI: this package ships no
            // QR encoder, so the key is the only reliably-workable path.
            expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeDefined();
            expect(screen.queryByText(OTPAUTH_URI_PATTERN)).toBeNull();
            expect(screen.getByText("aaa")).toBeDefined();
        });
    });
});
