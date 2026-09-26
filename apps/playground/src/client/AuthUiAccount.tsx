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
 * No routes here, as in {@link AuthUiDemo}: `<App>` swaps views off the
 * session, so a sign-out stays in the page the way it does under an SPA
 * router, instead of reloading it.
 */
const IN_PLACE_NAV = {
    navigate: (): void => undefined,
    replace: (): void => undefined,
};

/**
 * The signed-in half of the copy-in auth screens, mounted behind `?authui=1`
 * beside {@link AuthUiDemo}'s signed-out half.
 *
 * Only the cards that need no better-auth feature plugin are here. The
 * playground's client installs `lunoraSessionSync()` and nothing else, so
 * `PasskeysCard`, `TwoFactorSetupCard` and the organization cards have no server
 * half to talk to — mounting them would test that a 404 renders an error, which
 * is not the same as testing the card. They stay covered by the controller and
 * jsdom suites.
 */
export const AuthUiAccount = (): ReactElement => (
    <AuthUIProvider
        authClient={authClient}
        nav={IN_PLACE_NAV}
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
