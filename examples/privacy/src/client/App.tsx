import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement, SyntheticEvent } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";

/**
 * One page for the whole privacy surface: a task list, and the requests a user can
 * open against their own data. Every request id here comes from the server, and the
 * server decides whose data it is from the signed-in session.
 */
export const App = (): ReactElement => {
    const [draft, setDraft] = useState("");
    const [message, setMessage] = useState<string | undefined>(undefined);

    const tasks = useQuery(api.tasks.myTasks, {});
    const requests = useQuery(api.requests.myRequests, {});
    const { mutate: addTask } = useMutation(api.tasks.addTask);
    const { mutate: requestExport } = useMutation(api.requests.requestExport);
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
