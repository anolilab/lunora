import type { AuthCapabilities } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

    it("shows a load failure with a retry that loads the keys again", async () => {
        expect.assertions(1);

        let attempts = 0;
        const mock = createMockClient({
            listAuthApiKeys: async () => {
                attempts += 1;

                if (attempts === 1) {
                    throw new Error("boom");
                }

                return KEYS;
            },
        });

        renderPanel(mock);

        await screen.findByText("Could not load API keys.");
        fireEvent.click(screen.getByTestId("ud-api-keys-retry"));

        await screen.findByTestId("ud-api-keys-table");

        expect(mock.listAuthApiKeys).toHaveBeenCalledTimes(2);
    });

    it("ignores a slow response for the previously selected user", async () => {
        expect.assertions(2);

        const { promise: firstResponse, resolve: releaseFirst } = Promise.withResolvers<Record<string, unknown>[]>();
        const mock = createMockClient({
            listAuthApiKeys: async ({ userId }) => {
                if (userId === "u1") {
                    return firstResponse;
                }

                return [{ createdAt: 1, expiresAt: null, id: "k9", name: "bob-key", referenceId: "u2", start: "lnr_k9" }];
            },
        });

        const { rerender } = render(
            <LunoraProvider client={mock.asClient}>
                <UserSecurityPanel busy={false} capabilities={CAPABILITIES} runAction={vi.fn()} userId="u1" version={0} />
            </LunoraProvider>,
        );

        rerender(
            <LunoraProvider client={mock.asClient}>
                <UserSecurityPanel busy={false} capabilities={CAPABILITIES} runAction={vi.fn()} userId="u2" version={0} />
            </LunoraProvider>,
        );

        await screen.findByTestId("ud-api-key-k9");
        await act(async () => {
            releaseFirst(KEYS);
            await firstResponse;
        });

        expect(screen.queryByTestId("ud-api-key-k1")).toBeNull();
        expect(screen.getByTestId("ud-api-key-k9").textContent).toContain("bob-key");
    });

    it("keeps the newest refresh when an older request for the same user resolves last", async () => {
        expect.assertions(2);

        let calls = 0;
        const { promise: firstResponse, resolve: releaseFirst } = Promise.withResolvers<Record<string, unknown>[]>();
        const mock = createMockClient({
            listAuthApiKeys: async () => {
                calls += 1;

                if (calls === 1) {
                    return firstResponse;
                }

                return [{ createdAt: 1, expiresAt: null, id: "k2", name: "fresh", referenceId: "u1", start: "lnr_k2" }];
            },
        });

        const { rerender } = render(
            <LunoraProvider client={mock.asClient}>
                <UserSecurityPanel busy={false} capabilities={CAPABILITIES} runAction={vi.fn()} userId="u1" version={0} />
            </LunoraProvider>,
        );

        rerender(
            <LunoraProvider client={mock.asClient}>
                <UserSecurityPanel busy={false} capabilities={CAPABILITIES} runAction={vi.fn()} userId="u1" version={1} />
            </LunoraProvider>,
        );

        await screen.findByTestId("ud-api-key-k2");
        await act(async () => {
            releaseFirst([{ createdAt: 1, expiresAt: null, id: "k1", name: "stale", referenceId: "u1", start: "lnr_k1" }]);
            await firstResponse;
        });

        expect(screen.queryByTestId("ud-api-key-k1")).toBeNull();
        expect(screen.getByTestId("ud-api-key-k2").textContent).toContain("fresh");
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
