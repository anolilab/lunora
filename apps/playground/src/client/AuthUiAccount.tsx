import "@lunora/auth-ui/styles.css";

import { AuthUIProvider, ChangePasswordCard, DeleteAccountCard, ProfileCard, SessionsCard, SignOutButton } from "@lunora/auth-ui/react";
import type { CSSProperties, ReactElement } from "react";

import { authClient } from "./auth-client.js";

/** Hoisted so the literal isn't reallocated (and re-flagged) per render. */
const STACK_STYLE: CSSProperties = { display: "grid", gap: 24, margin: "24px auto", maxWidth: 480 };

/**
 * The signed-in half of the copy-in auth screens, mounted behind `?authui=1`
 * beside {@link AuthUiDemo}'s signed-out half.
 *
 * Only the cards that need no better-auth plugin are here. The playground's
 * client is a bare `createAuthClient` with no plugin array, so `PasskeysCard`,
 * `TwoFactorSetupCard` and the organization cards have no server half to talk to
 * — mounting them would test that a 404 renders an error, which is not the same
 * as testing the card. They stay covered by the controller and jsdom suites.
 */
export const AuthUiAccount = (): ReactElement => (
    <AuthUIProvider
        authClient={authClient as never}
        onSessionChange={() => {
            void authClient.getSession();
        }}
    >
        <div style={STACK_STYLE}>
            {/* No `defaultName` on purpose: the controller prefills from the
                session itself. Passing a live session value here would make it a
                controller dependency and reset the card on every refresh. */}
            <ProfileCard />
            <ChangePasswordCard />
            <SessionsCard />
            <DeleteAccountCard />
            <SignOutButton />
        </div>
    </AuthUIProvider>
);
