import { useMutation, useQuery } from "@cirrus/react";
import type { FormEvent, ReactElement } from "react";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api.js";
import type { Doc, Id } from "../../cirrus/_generated/dataModel.js";

/**
 * Tiny CRUD demo: list + create + toggle + delete, with optimistic updates.
 *
 * The `optimistic` callback on each mutation paints the new list state
 * immediately; if the server rejects the call the runtime rolls the cache
 * back automatically.
 */
export const App = (): ReactElement => {
    const [draft, setDraft] = useState("");

    const todos = useQuery(api.todos.list, {}) as Doc<"todos">[] | undefined;
    const { mutate: add, pending: addPending } = useMutation(api.todos.add);
    const { mutate: toggle } = useMutation(api.todos.toggle);
    const { mutate: remove } = useMutation(api.todos.remove);

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        const text = draft.trim();

        if (text === "") {
            return;
        }

        setDraft("");

        await add(
            { text },
            {
                optimistic: (current) => {
                    const list = (current as Doc<"todos">[] | undefined) ?? [];
                    const provisional: Doc<"todos"> = {
                        _id: `optimistic_${Date.now()}` as Id<"todos">,
                        _creationTime: Date.now(),
                        text,
                        done: false,
                        createdAt: Date.now(),
                    };

                    return [provisional, ...list];
                },
            },
        );
    };

    const onToggle = async (todo: Doc<"todos">): Promise<void> => {
        await toggle(
            { id: todo._id, done: !todo.done },
            {
                optimistic: (current) => {
                    const list = (current as Doc<"todos">[] | undefined) ?? [];

                    return list.map((entry) => (entry._id === todo._id ? { ...entry, done: !entry.done } : entry));
                },
            },
        );
    };

    const onDelete = async (todo: Doc<"todos">): Promise<void> => {
        await remove(
            { id: todo._id },
            {
                optimistic: (current) => {
                    const list = (current as Doc<"todos">[] | undefined) ?? [];

                    return list.filter((entry) => entry._id !== todo._id);
                },
            },
        );
    };

    return (
        <main style={{ maxWidth: 520, margin: "3rem auto", fontFamily: "system-ui" }}>
            <h1>Todos</h1>
            <form onSubmit={submit} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <input
                    onChange={(event) => {
                        setDraft(event.target.value);
                    }}
                    placeholder="What needs doing?"
                    style={{ flex: 1, padding: 8 }}
                    value={draft}
                />
                <button disabled={addPending} type="submit">
                    Add
                </button>
            </form>
            <ul style={{ listStyle: "none", padding: 0 }}>
                {(todos ?? []).map((todo) => (
                    <li key={todo._id} style={{ display: "flex", gap: 8, padding: 8, alignItems: "center" }}>
                        <input checked={todo.done} onChange={() => void onToggle(todo)} type="checkbox" />
                        <span style={{ flex: 1, textDecoration: todo.done ? "line-through" : "none" }}>{todo.text}</span>
                        <button onClick={() => void onDelete(todo)} type="button">
                            Delete
                        </button>
                    </li>
                ))}
            </ul>
        </main>
    );
};
