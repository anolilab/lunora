import { lunoraQueryOptions, useConnectionStatus, useMutation, useQuery } from "@lunora/react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";

/**
 * One text field out of a `FormData`.
 *
 * `FormData.get` is typed `string | File | null`, so `String(form.get(name) ?? "")`
 * stringifies a `File` to `"[object File]"` — a file input sharing a text field's
 * name would submit that verbatim. Narrowing instead yields `""` for anything
 * that is not text.
 */
const textField = (form: FormData, name: string): string => {
    const value = form.get(name);

    return typeof value === "string" ? value : "";
};

const BOARD_ARGS = { limit: 50 } as const;

/**
 * `getRouteApi` rather than `Route.useLoaderData()`: `Route` below names `Home`
 * in its `component:` option, so reaching back through `Route` from inside
 * `Home` makes the two declarations mutually referential and TypeScript gives
 * up and infers the loader data as `any`.
 */
const route = getRouteApi("/");

const Home = (): ReactElement => {
    /**
     * The same query, live. `undefined` until the socket delivers its first
     * push; from then on every change arrives as a push and nothing refetches.
     */
    const live = useQuery(api.messages.board, BOARD_ARGS);

    /**
     * The loader's value, carried into the browser inside the HTML — what fills
     * the gap above.
     *
     * The router serializes loader results for us, but the TanStack Query cache
     * the loader wrote into is NOT serialized, so on the client `useQuery`
     * starts from an empty cache and has nothing on its very first render. This
     * page used to render its empty state in that gap while the server had
     * already shipped a populated list, which React reports as "Hydration
     * failed because the server rendered HTML didn't match the client" and
     * answers by discarding the entire server tree — turning the SSR this
     * example is about into pure overhead. Reading the loader's own value is
     * what makes the first client render match the server's.
     *
     * The annotation is not decoration. `routeTree.gen.ts` types this route
     * through the `Route` declared at the bottom of *this* file, so the loop
     * collapses to `any` when read from inside it and every `board.*` below
     * would go unchecked. Anchoring it to `live`'s own type keeps the snapshot
     * and the live value in step by construction.
     */
    const initial: NonNullable<typeof live> = route.useLoaderData();

    const board = live ?? initial;
    const { mutate: send, pending } = useMutation(api.messages.send);

    /**
     * The one thing the server render cannot tell you: whether the socket is up
     * yet. Until it is, the page is a snapshot — worth saying out loud in an
     * example whose whole point is the handover from SSR to live.
     */
    const status = useConnectionStatus();

    return (
        <main className="page">
            <header>
                <h1>Lunora + TanStack Start</h1>
                <p className="muted">Server-rendered from the route loader, then live over a socket.</p>
                <p className={status === "connected" ? "status live" : "status"}>{status === "connected" ? "live" : status}</p>
            </header>

            {/*
             * A React 19 form `action` rather than `onSubmit` + `preventDefault`:
             * React owns the submission, so the form resets itself on success and
             * still works before hydration finishes — which matters here, where
             * the first paint comes from the server.
             */}
            <form
                action={(data: FormData) => {
                    const body = textField(data, "body").trim();

                    if (!body) {
                        return;
                    }

                    void send({ author: textField(data, "author").trim() || "anon", body });
                }}
            >
                <input aria-label="Your name" name="author" placeholder="Your name" />
                <input aria-label="Message" maxLength={140} name="body" placeholder="Write a message" required />
                <button disabled={pending} type="submit">
                    {pending ? "Sending…" : "Send"}
                </button>
            </form>

            {/*
             * No loading branch. There is never a render without a board: the
             * loader resolves one before the route commits on either side, and
             * `live` only ever replaces it. A "Connecting…" placeholder here
             * would only ever paint on the client, against a server that had
             * already sent the list — which is the hydration mismatch itself.
             */}
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
                         * UTC, not `toLocaleTimeString()`. Locale and time zone
                         * differ between the server render and the browser that
                         * hydrates it, so a localised string is a hydration
                         * mismatch — in the one example whose whole point is
                         * server rendering. `<time>` carries the machine-readable
                         * value; localise in an effect if you want the reader's
                         * zone.
                         */}
                        <time dateTime={new Date(board.newestAt).toISOString()}>{new Date(board.newestAt).toISOString().slice(11, 19)} UTC</time>
                    </>
                )}
                . View source on the first paint — the list is already in the HTML.
            </p>
        </main>
    );
};

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
