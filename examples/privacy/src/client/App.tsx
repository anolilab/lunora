import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement, SyntheticEvent } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { authClient } from "./auth-client";
import { SignIn } from "./SignIn";

/**
 * The signed-in page: a task list, and the requests a user can open against their own data. Every request id
 * here comes from the server, and the server decides whose data it is from the signed-in session. It mounts
 * only once there is a session, so its live queries never subscribe as an anonymous caller.
 */
/** The Worker's origin: the same one the Lunora client talks to. */
const lunoraOrigin = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;

const Workspace = ({ email }: { readonly email: string }): ReactElement => {
    const [draft, setDraft] = useState("");
    const [message, setMessage] = useState<string | undefined>(undefined);

    const tasks = useQuery(api.tasks.myTasks, {});
    const requests = useQuery(api.requests.myRequests, {});
    const { mutate: addTask } = useMutation(api.tasks.addTask);
    const { mutate: requestExport } = useMutation(api.requests.requestExport);
    const { mutate: downloadLink } = useMutation(api.requests.downloadLink);
    const { mutate: requestErasure } = useMutation(api.requests.requestErasure);
    const { mutate: cancelRequest } = useMutation(api.requests.cancelRequest);

    /** Runs one action and reports its outcome. A refusal from the server is shown as the message, not thrown. */
    const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
        try {
            await action();
            setMessage(`${label}: done`);
        } catch (error) {
            setMessage(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        const title = draft.trim();

        if (title === "") {
            return;
        }

        setDraft("");
        await attempt("Add task", async () => addTask({ title }));
    };

    return (
        <main>
            <h1>Your data</h1>

            <p>
                Signed in as {email}{" "}
                <button
                    onClick={() => {
                        void authClient.signOut();
                    }}
                    type="button"
                >
                    Sign out
                </button>
            </p>

            <form
                onSubmit={(event) => {
                    void submit(event);
                }}
            >
                <label htmlFor="new-task">
                    New task
                    <input
                        id="new-task"
                        onChange={(event) => {
                            setDraft(event.target.value);
                        }}
                        placeholder="A task"
                        value={draft}
                    />
                </label>
                <button type="submit">Add</button>
            </form>

            <ul>
                {(tasks ?? []).map((task) => (
                    <li key={task._id}>{task.title}</li>
                ))}
            </ul>

            <section>
                <h2>Requests</h2>
                <button
                    onClick={() => {
                        void attempt("Export", async () => requestExport({}));
                    }}
                    type="button"
                >
                    Export my data
                </button>{" "}
                <button
                    onClick={() => {
                        void attempt("Erase", async () => requestErasure({}));
                    }}
                    type="button"
                >
                    Erase my data
                </button>
                <ul>
                    {(requests ?? []).map((request) => (
                        <li key={request.id}>
                            {request.type} · {request.status}{" "}
                            {request.status === "ready" ? (
                                <button
                                    onClick={() => {
                                        void attempt("Download", async () => {
                                            // A fresh link on each click: it expires after fifteen minutes.
                                            // The link is a path on the Worker, so resolve it against the Worker's origin.
                                            const link = await downloadLink({ requestId: request.id });
                                            globalThis.location.assign(new URL(link, lunoraOrigin).href);
                                        });
                                    }}
                                    type="button"
                                >
                                    Download
                                </button>
                            ) : undefined}
                            {request.status === "grace" ? (
                                <button
                                    onClick={() => {
                                        void attempt("Cancel", async () => cancelRequest({ requestId: request.id }));
                                    }}
                                    type="button"
                                >
                                    Cancel
                                </button>
                            ) : undefined}
                        </li>
                    ))}
                </ul>
            </section>

            {message === undefined ? undefined : <p role="status">{message}</p>}
        </main>
    );
};

/** The session gate: the sign-in form until there is a session, then the page. */
export const App = (): ReactElement => {
    const session = authClient.useSession();

    if (session.isPending) {
        return <p>Loading…</p>;
    }

    if (session.data === null) {
        return <SignIn />;
    }

    return <Workspace email={session.data.user.email} />;
};
