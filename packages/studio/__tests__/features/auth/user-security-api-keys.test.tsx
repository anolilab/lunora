import type { AuthCapabilities } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UserSecurityPanel } from "../../../src/features/auth/user-related-panels";
import { fireAndForget } from "../../../src/lib/internal";
import { createMockClient } from "../../mock-client";

const CAPABILITIES: AuthCapabilities = { accounts: true, apiKey: true, admin: true, inviteOnly: false, organization: false, passkey: false, twoFactor: false };

const KEYS = [
    { createdAt: 1_700_000_000_000, enabled: true, expiresAt: null, id: "k1", name: "ci", referenceId: "u1", start: "lnr_k1" },
    { createdAt: 1_700_000_000_000, enabled: true, expiresAt: null, id: "k2", name: "laptop", referenceId: "u1", start: "lnr_k2" },
];

const renderPanel = (mock: ReturnType<typeof createMockClient>, capabilities: AuthCapabilities = CAPABILITIES) => {
    const runAction = vi.fn<(action: () => Promise<void>) => void>((action) => {
        fireAndForget(action());
    });

    render(
        <LunoraProvider client={mock.asClient}>
            <UserSecurityPanel busy={false} capabilities={capabilities} runAction={runAction} userId="u1" version={0} />
        </LunoraProvider>,
    );

    return { runAction };
};

describe("userSecurityPanel API keys", () => {
    it("lists the user's keys by name and prefix, with an expiry of Never when unset", async () => {
        expect.assertions(3);

        const mock = createMockClient({ listAuthApiKeys: async () => KEYS });

        renderPanel(mock);

        await screen.findByTestId("ud-api-keys-table");

        expect(screen.getByTestId("ud-api-key-k1").textContent).toContain("ci");
        expect(screen.getByTestId("ud-api-key-k1").textContent).toContain("lnr_k1");
        expect(screen.getByTestId("ud-api-key-k1").textContent).toContain("Never");
    });

    it("revokes one key by id from its row", async () => {
        expect.assertions(2);

        const mock = createMockClient({ listAuthApiKeys: async () => KEYS });
        const { runAction } = renderPanel(mock);

        await screen.findByTestId("ud-api-keys-table");
        fireEvent.click(screen.getByTestId("ud-revoke-api-key-k2"));

        expect(runAction).toHaveBeenCalledTimes(1);
        expect(mock.deleteAuthApiKey).toHaveBeenCalledWith({ apiKeyId: "k2" });
    });

    it("says so when the user has no keys", async () => {
        expect.assertions(1);

        renderPanel(createMockClient({ listAuthApiKeys: async () => [] }));

        await expect(screen.findByText("No API keys.")).resolves.toBeDefined();
    });

    it("does not fetch or render keys when the plugin is off", async () => {
        expect.assertions(2);

        const mock = createMockClient({ listAuthApiKeys: async () => KEYS });

        renderPanel(mock, { ...CAPABILITIES, apiKey: false });

        await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
        });

        expect(mock.listAuthApiKeys).not.toHaveBeenCalled();
        expect(screen.queryByTestId("ud-api-keys-table")).toBeNull();
    });
});
