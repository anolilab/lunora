import "@lunora/auth-ui/styles.css";

import { AuthUIProvider, ForgotPasswordCard, SignInCard, SignUpCard } from "@lunora/auth-ui/react";
import type { CSSProperties, ReactElement } from "react";
import { useState } from "react";

import { authClient } from "./auth-client.js";

type Screen = "forgot" | "sign-in" | "sign-up";

/** Hoisted so the literals aren't reallocated (and re-flagged) per render. */
const NAV_STYLE: CSSProperties = { display: "flex", gap: 12, justifyContent: "center", padding: 16 };

const screenFor = (to: string): Screen => {
    if (to.includes("sign-up")) {
        return "sign-up";
    }

    return to.includes("forgot") ? "forgot" : "sign-in";
};

/**
 * The copy-in auth screens (`lunora add auth-ui`) mounted against this app's
 * real worker, so the E2E suite exercises the shipped cards in a browser rather
 * than only in jsdom.
 *
 * It lives behind `?authui=1` and beside {@link Login} on purpose: the existing
 * specs drive the hand-rolled form, and swapping it out would make this a UI
 * migration rather than added coverage.
 */
export const AuthUiDemo = (): ReactElement => {
    const [screen, setScreen] = useState<Screen>("sign-in");

    // No router in this app: swap the rendered card instead of navigating.
    const [nav] = useState(() => {
        return {
            navigate: (to: string): void => {
                setScreen(screenFor(to));
            },
            replace: (): void => {
                // No routes here; <App> swaps itself once the session resolves.
            },
        };
    });

    return (
        <AuthUIProvider
            authClient={authClient}
            nav={nav}
            // A same-origin cookie sign-in changes no token, so nothing prompts
            // `useSession` to re-read on its own — re-fetch it here. This is the
            // wiring the docs call out, and the reason <App> flips to the chat
            // view after the card signs in.
            onSessionChange={() => {
                void authClient.getSession();
            }}
        >
            {/* Labelled "Show …" so they never collide with the cards' own submit
                buttons — both by role and for anyone reading the screen aloud. */}
            <nav style={NAV_STYLE}>
                <button
                    onClick={() => {
                        setScreen("sign-in");
                    }}
                    type="button"
                >
                    Show sign in
                </button>
                <button
                    onClick={() => {
                        setScreen("sign-up");
                    }}
                    type="button"
                >
                    Show sign up
                </button>
                <button
                    onClick={() => {
                        setScreen("forgot");
                    }}
                    type="button"
                >
                    Show forgot password
                </button>
            </nav>
            {screen === "sign-in" ? <SignInCard /> : null}
            {screen === "sign-up" ? <SignUpCard /> : null}
            {screen === "forgot" ? <ForgotPasswordCard /> : null}
        </AuthUIProvider>
    );
};
