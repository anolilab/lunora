import { useAuth, useQuery } from "@lunora/react";
import type { CSSProperties, ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
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

/**
 * `?authstore=1`: also mount `@lunora/react`'s `useAuth`, which resolves the
 * Lunora identity itself. Without the flag the app reads its session through
 * better-auth alone, and the Lunora client learns who it is from
 * `lunoraSessionSync()` and its sockets — the two shapes an app can take.
 */
const IdentityStore = (): null => {
    useAuth();

    return null;
};

/** The signed-in user's private notes, live, beside the account cards. */
const AccountNotes = (): ReactElement => {
    const notes = useQuery(api.notes.list, {});

    return (
        <ul data-testid="account-notes">
            {(notes ?? []).map((note) => (
                <li key={note._id}>{note.text}</li>
            ))}
        </ul>
    );
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
                <AccountNotes />
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
            {search.includes("authstore=1") ? <IdentityStore /> : null}
            <Chat userId={session.data.user.id} />
        </>
    );
};
