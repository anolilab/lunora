import { useMutation, useQuery } from "@lunora/react";
import { useAuth } from "@workos-inc/authkit-react";
import type { ReactElement, SyntheticEvent } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc as Document_ } from "../../lunora/_generated/dataModel.js";

const NoteList = ({ notes }: { notes: Document_<"notes">[] | undefined }): ReactElement => {
    if (notes === undefined) {
        return <p>Loading…</p>;
    }

    if (notes.length === 0) {
        return <p>Nothing here yet.</p>;
    }

    return (
        <ul>
            {notes.map((note) => (
                <li key={note._id}>{note.text}</li>
            ))}
        </ul>
    );
};

const Notes = (): ReactElement => {
    const [draft, setDraft] = useState("");
    // Both are live queries over the authenticated socket: a note added in
    // another tab appears here without a refetch.
    const mine = useQuery(api.notes.mine, {});
    const orgNotes = useQuery(api.notes.orgNotes, {});
    const { mutate: add } = useMutation(api.notes.add);

    const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        const text = draft.trim();

        if (text !== "") {
            setDraft("");
            await add({ text });
        }
    };

    return (
        <>
            <form
                onSubmit={(event) => {
                    void submit(event);
                }}
            >
                <input
                    aria-label="New note"
                    onChange={(event) => {
                        setDraft(event.target.value);
                    }}
                    placeholder="Write a note"
                    value={draft}
                />
                <button type="submit">Add</button>
            </form>
            <h2>My notes</h2>
            <NoteList notes={mine} />
            <h2>Organization notes (org admins only)</h2>
            <NoteList notes={orgNotes} />
        </>
    );
};

export const App = (): ReactElement => {
    const { isLoading, organizationId, role, signIn, signOut, user } = useAuth();

    if (isLoading) {
        return <p>Loading…</p>;
    }

    return (
        <main>
            <h1>Lunora × WorkOS</h1>
            {user ? (
                <>
                    <p>
                        Signed in as {user.email}
                        {organizationId ? ` in ${organizationId} (${role ?? "no role"})` : ""}{" "}
                        <button
                            onClick={() => {
                                signOut();
                            }}
                            type="button"
                        >
                            Sign out
                        </button>
                    </p>
                    <Notes />
                </>
            ) : (
                <button
                    onClick={() => {
                        void signIn();
                    }}
                    type="button"
                >
                    Sign in
                </button>
            )}
        </main>
    );
};
