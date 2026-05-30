import type { CSSProperties, ReactElement } from "react";

import { authClient } from "./auth-client.js";
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

    if (!session.data) {
        return <Login />;
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
