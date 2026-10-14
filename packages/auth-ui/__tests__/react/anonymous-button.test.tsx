/**
 * `signIn.anonymous` creates an account every time it is called, and the button
 * gives no feedback of its own — so an unguarded one turns an impatient
 * double-click into two anonymous users, the second of them orphaned.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../../src/core";
import { registerAuthClientPlugins } from "../../src/core";
import { AnonymousButton, AuthUIProvider } from "../../src/react";
import { fakeNav } from "../fake-client";

describe(AnonymousButton, () => {
    it("disables itself while the sign-in is in flight, so a double-click makes one user", async () => {
        const anonymous = vi.fn(() => new Promise<never>(() => {}));
        const client = { signIn: { anonymous } } as unknown as AuthClient;

        registerAuthClientPlugins(client, { anonymous: true });

        render(
            <AuthUIProvider authClient={client} discover={false} nav={fakeNav()}>
                <AnonymousButton />
            </AuthUIProvider>,
        );

        const button = screen.getByRole("button");

        fireEvent.click(button);

        await waitFor(() => {
            expect(button).toHaveProperty("disabled", true);
        });

        fireEvent.click(button);

        expect(anonymous).toHaveBeenCalledTimes(1);
    });
});
