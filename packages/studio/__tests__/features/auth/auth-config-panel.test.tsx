import type { AuthCapabilities } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { AuthConfigPanel } from "../../../src/features/auth/auth-config-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const CAPABILITIES: AuthCapabilities = { accounts: true, admin: true, organization: false, passkey: true, twoFactor: false };

const createConfigClient = (): MockClientHooks => {
    const mock = createMockClient();

    mock.getAuthCapabilities.mockResolvedValue(CAPABILITIES);

    return mock;
};

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <AuthConfigPanel />
    </CirrusProvider>
);

describe("authConfigPanel", () => {
    it("renders a badge per capability reflecting its enabled state", async () => {
        expect.assertions(5);

        render(renderPanel(createConfigClient()));

        await screen.findByTestId("auth-config-cap-admin");

        expect(screen.getByTestId("auth-config-cap-admin").textContent).toContain("Enabled");
        expect(screen.getByTestId("auth-config-cap-organization").textContent).toContain("Disabled");
        expect(screen.getByTestId("auth-config-cap-passkey").textContent).toContain("Enabled");
        expect(screen.getByTestId("auth-config-cap-twoFactor").textContent).toContain("Disabled");
        expect(screen.getByTestId("auth-config-cap-accounts").textContent).toContain("Enabled");
    });

    it("renders the read-only deploy-time note", async () => {
        expect.assertions(2);

        render(renderPanel(createConfigClient()));

        const note = await screen.findByTestId("auth-config-note");

        expect(note.textContent).toContain("deploy time");
        expect(note.textContent).toContain("Mail");
    });

    it("surfaces a capabilities-fetch error", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.getAuthCapabilities.mockRejectedValueOnce(new Error("AUTH_NOT_CONFIGURED"));

        render(renderPanel(mock));

        const error = await screen.findByTestId("auth-config-error");

        expect(error.textContent).toBe("AUTH_NOT_CONFIGURED");
    });
});
