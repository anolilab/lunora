import "@lunora/auth-ui/styles.css";

import {
    AuthUIProvider,
    ChangePasswordCard,
    DeleteAccountCard,
    ErrorToaster,
    ProfileCard,
    SessionsCard,
    SignOutButton,
    UserButton,
} from "@lunora/auth-ui/react";
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
            {/* The avatar menu, which is the one new component with real browser
                behaviour to verify — a disclosure with Escape and outside-click
                handling that jsdom exercises but a real browser can disagree
                with. Everything below it is a form. */}
            <UserButton />
            {/* No `defaultName` on purpose: the controller prefills from the
                session itself. Passing a live session value here would make it a
                controller dependency and reset the card on every refresh. */}
            <ProfileCard />
            <ChangePasswordCard />
            <SessionsCard />
            <DeleteAccountCard />
            <SignOutButton />
            {/* Mounted so a failure with no card to land in is still visible. */}
            <ErrorToaster />
        </div>
    </AuthUIProvider>
);
