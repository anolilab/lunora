import type { CSSProperties, ReactElement } from "react";

import { authClient } from "./auth-client.js";
import { AuthUiAccount } from "./AuthUiAccount.js";
import { AuthUiDemo } from "./AuthUiDemo.js";
import { Chat } from "./Chat.js";
import { Login } from "./Login.js";

// Hoisted so the inline literals aren't reallocated (and re-flagged) per render.
const LOADING_STYLE: CSSProperties = { margin: "4rem auto", textAlign: "center" };
const HEADER_STYLE: CSSProperties = {
    alignItems: "center",
    borderBottom: "1px solid #eee",
    display: "flex",
    gap: 12,
    justifyContent: "space-between",
    padding: "8px 16px",
};

export const App = (): ReactElement => {
    const session = authClient.useSession();

    if (session.isPending) {
        return <p style={LOADING_STYLE}>Loading…</p>;
    }

    /*
     * Two flags, because the account cards only exist once there is a session and
     * the signed-out specs assert they land in the chat view afterwards:
     *
     *   ?authui=1        signed-out cards, then the normal chat view on sign-in
     *   ?authui=account  same cards signed out, the account cards signed in
     *
     * Keeping them separate is what lets the four original specs stay untouched.
     */
    const { search } = globalThis.location;
    const authUiAccount = search.includes("authui=account");

    if (!session.data) {
        return search.includes("authui=1") || authUiAccount ? <AuthUiDemo /> : <Login />;
    }

    if (authUiAccount) {
        return (
            <>
                <header style={HEADER_STYLE}>
                    <span>
                        Signed in as <strong>{session.data.user.email}</strong>
                    </span>
                </header>
                <AuthUiAccount />
            </>
        );
    }

    return (
        <>
            <header style={HEADER_STYLE}>
                <span>
                    Signed in as <strong>{session.data.user.email}</strong>
                </span>
                <button
                    onClick={() => {
                        void authClient.signOut();
                    }}
                    type="button"
                >
                    Sign out
                </button>
            </header>
            <Chat />
        </>
    );
};
