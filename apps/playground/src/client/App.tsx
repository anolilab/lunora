import type { ReactElement } from "react";

import { authClient } from "./auth-client.js";
import { Chat } from "./Chat.js";
import { Login } from "./Login.js";

export const App = (): ReactElement => {
    const session = authClient.useSession();

    if (session.isPending) {
        return <p style={{ margin: "4rem auto", textAlign: "center" }}>Loading…</p>;
    }

    if (!session.data) {
        return <Login />;
    }

    return (
        <>
            <header
                style={{ alignItems: "center", borderBottom: "1px solid #eee", display: "flex", gap: 12, justifyContent: "space-between", padding: "8px 16px" }}
            >
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
