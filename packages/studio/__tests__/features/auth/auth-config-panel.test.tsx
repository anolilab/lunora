import type { AuthCapabilities, AuthConfigInfo } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import AuthConfigPanel from "../../../src/features/auth/auth-config-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const CAPABILITIES: AuthCapabilities = { accounts: true, admin: true, inviteOnly: false, organization: true, passkey: true, twoFactor: false };

const CONFIG: AuthConfigInfo = {
    capabilities: CAPABILITIES,
    emailAndPassword: true,
    organization: { enabled: true, roles: true, teams: false },
    plugins: ["organization", "passkey"],
    rateLimit: { enabled: true, max: 100, window: 60 },
    session: { cookieCache: true, expiresIn: 604_800, freshAge: 3600, updateAge: 86_400 },
    socialProviders: ["github", "google"],
    userFields: [{ name: "phoneNumber", plugin: "phone-number", required: false, type: "string", unique: true }],
};

const createConfigClient = (config: AuthConfigInfo = CONFIG): MockClientHooks => {
    const mock = createMockClient();

    mock.getAuthConfig.mockResolvedValue(config);

    return mock;
};

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <AuthConfigPanel />
    </LunoraProvider>
);

describe("authConfigPanel", () => {
    it("renders a badge per capability reflecting its enabled state", async () => {
        expect.assertions(5);

        render(renderPanel(createConfigClient()));

        await screen.findByTestId("auth-config-cap-admin");

        expect(screen.getByTestId("auth-config-cap-admin").textContent).toContain("Enabled");
        expect(screen.getByTestId("auth-config-cap-organization").textContent).toContain("Enabled");
        expect(screen.getByTestId("auth-config-cap-passkey").textContent).toContain("Enabled");
        expect(screen.getByTestId("auth-config-cap-twoFactor").textContent).toContain("Disabled");
        expect(screen.getByTestId("auth-config-cap-accounts").textContent).toContain("Enabled");
    });

    it("lists the enabled plugins, social providers, and plugin user fields", async () => {
        expect.assertions(4);

        render(renderPanel(createConfigClient()));

        await screen.findByTestId("auth-config-plugins");

        expect(screen.getByTestId("auth-config-plugin-organization").textContent).toContain("organization");
        expect(screen.getByTestId("auth-config-provider-github").textContent).toContain("github");
        expect(screen.getByTestId("auth-config-user-field-phoneNumber").textContent).toContain("phoneNumber");
        expect(screen.getByTestId("auth-config-user-field-phoneNumber").textContent).toContain("unique");
    });

    it("summarizes the session and rate-limit policy", async () => {
        expect.assertions(2);

        render(renderPanel(createConfigClient()));

        const session = await screen.findByTestId("auth-config-session");

        // 604_800s → 7 days; 60s window → 1m.
        expect(session.textContent).toContain("7d");
        expect(screen.getByTestId("auth-config-ratelimit").textContent).toContain("1m");
    });

    it("renders the read-only deploy-time note", async () => {
        expect.assertions(2);

        render(renderPanel(createConfigClient()));

        const note = await screen.findByTestId("auth-config-note");

        expect(note.textContent).toContain("deploy time");
        expect(note.textContent).toContain("Mail");
    });

    it("surfaces a config-fetch error", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.getAuthConfig.mockRejectedValueOnce(new Error("AUTH_NOT_CONFIGURED"));

        render(renderPanel(mock));

        const error = await screen.findByTestId("auth-config-error");

        expect(error.textContent).toBe("AUTH_NOT_CONFIGURED");
    });
});
