import { lunoraQueryOptions, useMutation, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";

const BOARD_ARGS = { limit: 50 } as const;

export const Route = createFileRoute("/")({
    component: Home,
    /**
     * The SSR read. `lunoraQueryOptions` builds a one-shot HTTP fetch keyed
     * exactly like the live `useQuery` hook below, so the value the server puts
     * in the cache is the value the component finds there on its first render —
     * fully rendered markup, no loading flash, no second request on hydration.
     */
    loader: async ({ context }) => context.queryClient.ensureQueryData(lunoraQueryOptions(context.lunora, api.messages.board, BOARD_ARGS)),
});

function Home(): ReactElement {
    /**
     * The same query, now live. On the first client render it reads the
     * loader's cached value (same key), then the subscription attaches and
     * every later change arrives as a push. Nothing refetches.
     */
    const board = useQuery(api.messages.board, BOARD_ARGS);
    const { mutate: send, pending } = useMutation(api.messages.send);

    return (
        <main className="page">
            <header>
                <h1>Lunora + TanStack Start</h1>
                <p className="muted">Server-rendered from the route loader, then live over a socket.</p>
            </header>

            {/*
             * A React 19 form `action` rather than `onSubmit` + `preventDefault`:
             * React owns the submission, so the form resets itself on success and
             * still works before hydration finishes — which matters here, where
             * the first paint comes from the server.
             */}
            <form
                action={(data: FormData) => {
                    const body = String(data.get("body") ?? "").trim();

                    if (!body) {
                        return;
                    }

                    void send({ author: String(data.get("author") ?? "").trim() || "anon", body });
                }}
            >
                <input aria-label="Your name" name="author" placeholder="Your name" />
                <input required aria-label="Message" maxLength={140} name="body" placeholder="Write a message" />
                <button disabled={pending} type="submit">
                    {pending ? "Sending…" : "Send"}
                </button>
            </form>

            {board === undefined ? (
                <p className="muted">Connecting…</p>
            ) : (
                <>
                    <ul>
                        {board.messages.map((message) => (
                            <li key={message._id}>
                                <strong>{message.author}</strong> {message.body}
                            </li>
                        ))}
                        {board.messages.length === 0 && <li className="muted">Nothing yet. Write the first one.</li>}
                    </ul>

                    <p className="muted">
                        {board.total} message(s)
                        {board.newestAt > 0 && (
                            <>
                                , newest{" "}
                                {/*
                                 * UTC, not `toLocaleTimeString()`. Locale and time
                                 * zone differ between the server render and the
                                 * browser that hydrates it, so a localised string
                                 * is a hydration mismatch — in the one example
                                 * whose whole point is server rendering. `<time>`
                                 * carries the machine-readable value; localise in
                                 * an effect if you want the reader's zone.
                                 */}
                                <time dateTime={new Date(board.newestAt).toISOString()}>{new Date(board.newestAt).toISOString().slice(11, 19)} UTC</time>
                            </>
                        )}
                        . View source on the first paint — the list is already in the HTML.
                    </p>
                </>
            )}
        </main>
    );
}
