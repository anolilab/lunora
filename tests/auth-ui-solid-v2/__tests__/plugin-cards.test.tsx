/**
 * Solid 2 port: the two rows whose actions are keyed by an identifier the
 * server may omit. Flow logic is covered framework-agnostically in
 * `packages/auth-ui/__tests__/core`; this asserts the guard that keeps a row
 * with no identifier from posting an empty one, plus the retry label on the
 * verification card — both of which live only in the view.
 */
import { render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../../packages/auth-ui/src/core";
import { AdminUsersCard, AuthUIProvider, MultiSessionCard, VerifyEmailCard } from "../../../packages/auth-ui/src/solid-v2";

const ok = <T,>(data: T): Promise<{ data: T; error: null }> => Promise.resolve({ data, error: null });

/**
 * One row that carries its identifier and one that does not. An unregistered
 * client enables every flow, which is what these cards gate on.
 */
const listClient = (): AuthClient =>
    ({
        admin: {
            listUsers: vi.fn(() =>
                ok({
                    users: [{ email: "ada@example.com", id: "user_1" }, { email: "grace@example.com" }],
                }),
            ),
        },
        getSession: vi.fn(() => ok({ user: { email: "ada@example.com" } })),
        multiSession: {
            listDeviceSessions: vi.fn(() =>
                ok([{ session: { token: "tok_1" }, user: { email: "ada@example.com" } }, { user: { email: "grace@example.com" } }]),
            ),
        },
    }) as unknown as AuthClient;

const renderCard = (card: () => ReturnType<typeof MultiSessionCard>, authClient: AuthClient): void => {
    render(() => <AuthUIProvider authClient={authClient}>{card()}</AuthUIProvider>);
};

/** The resource controllers load on mount, so the rows land a microtask later. */
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    flush();
};

describe("solid-v2 MultiSessionCard", () => {
    it("disables the row actions when the session carries no token", async () => {
        expect.assertions(4);

        renderCard(() => <MultiSessionCard />, listClient());
        await settle();

        // Matched by prefix: each row's action is named for the account it acts
        // on, so a list of identical "Switch to this account" buttons is not
        // what a screen reader hears any more.
        const [switchWithToken, switchWithout] = screen.getAllByRole("button", { name: /^Switch to this account: / });
        const [signOutWithToken, signOutWithout] = screen.getAllByRole("button", { name: /^Sign out: / });

        expect(switchWithToken).toHaveAccessibleName("Switch to this account: ada@example.com");
        expect(signOutWithToken).not.toBeDisabled();
        expect(switchWithout).toBeDisabled();
        expect(signOutWithout).toBeDisabled();
    });
});

describe("solid-v2 AdminUsersCard", () => {
    it("disables the row actions when the user carries no id", async () => {
        expect.assertions(4);

        renderCard(() => <AdminUsersCard />, listClient());
        await settle();

        const [impersonateWithId, impersonateWithout] = screen.getAllByRole("button", { name: /^Impersonate: / });
        const [banWithId, banWithout] = screen.getAllByRole("button", { name: /^Ban: / });

        // Ban and impersonate are the two row actions where an ambiguous name is
        // actually dangerous, so assert this one carries its user.
        expect(banWithId).toHaveAccessibleName("Ban: ada@example.com");
        expect(impersonateWithId).not.toBeDisabled();
        expect(impersonateWithout).toBeDisabled();
        expect(banWithout).toBeDisabled();
    });
});

describe("solid-v2 VerifyEmailCard", () => {
    it("offers a retry, not a new link, when the token failed", async () => {
        expect.assertions(1);

        renderCard(() => <VerifyEmailCard />, listClient());
        await settle();

        // The button re-runs `verify()` with the same token, so "Send a new
        // link" — which is what `ResendVerificationCard` does — would be a lie.
        expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    });
});
