import { useLunora, useMutation, useQuery } from "@lunora/react";
import { subscribeToPush } from "@lunora/notify/web";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc } from "../../lunora/_generated/dataModel.js";

// The VAPID **public** key the server signs with (`VAPID_PUBLIC_KEY`). Set it in
// the client env as `VITE_VAPID_PUBLIC_KEY`; a real deploy generates the pair
// with `npx web-push generate-vapid-keys`.
const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? "";

/**
 * End-to-end `@lunora/notify` demo:
 *
 * 1. `subscribeToPush` (`@lunora/notify/web`) registers a service worker and
 *    returns a plain Web Push subscription.
 * 2. The `registerDevice` mutation persists it via `ctx.push.register`.
 * 3. The `broadcast` action fans a push out to every registered device
 *    (`ctx.push.broadcast`) and records it (`announce`).
 *
 * Registered devices — with their last-send status and any delivery error — show
 * up in the Studio Notifications page (the `listPushSubscriptions` admin RPC).
 */
export const App = (): ReactElement => {
    const client = useLunora();
    const announcements = useQuery(api.push.listAnnouncements, {}) as Doc<"announcements">[] | undefined;
    const { mutate: registerDevice } = useMutation(api.push.registerDevice);
    const { mutate: announce } = useMutation(api.push.announce);

    const [title, setTitle] = useState("New drop");
    const [body, setBody] = useState("Something just shipped.");
    const [status, setStatus] = useState<string>("");

    const enablePush = async (): Promise<void> => {
        try {
            // `replacedEndpoint` is set only after a VAPID rotation: the stale
            // subscription is dropped for a new one under a new endpoint, so the
            // server row keyed on the old endpoint is orphaned until we say so.
            const { replacedEndpoint, subscription } = await subscribeToPush({ serviceWorkerUrl: "/sw.js", vapidPublicKey: VAPID_PUBLIC_KEY });

            await registerDevice({ replacedEndpoint, subscription });
            setStatus("Device registered for push.");
        } catch (error) {
            setStatus(`Could not enable push: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const send = async (): Promise<void> => {
        // Record the announcement (mutation) and fan the push out to every
        // registered device (action — sends are external I/O, so they live there).
        await announce({ body, title });
        const result = await client.action(api.push.broadcast, { body, title });

        setStatus(`Broadcast: ${result.sent} sent, ${result.failed} failed, ${result.pruned} pruned.`);
    };

    return (
        <main style={{ fontFamily: "system-ui", margin: "3rem auto", maxWidth: 560 }}>
            <h1>Notify demo</h1>

            <button onClick={() => void enablePush()} type="button">
                Enable push on this device
            </button>

            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                }}
                style={{ display: "flex", flexDirection: "column", gap: 8, margin: "16px 0" }}
            >
                <input
                    onChange={(event) => {
                        setTitle(event.target.value);
                    }}
                    placeholder="Title"
                    value={title}
                />
                <textarea
                    onChange={(event) => {
                        setBody(event.target.value);
                    }}
                    placeholder="Body"
                    value={body}
                />
                <button type="submit">Broadcast to all devices</button>
            </form>

            {status !== "" && <p style={{ color: "#555" }}>{status}</p>}

            <h2>Announcements</h2>
            <ul style={{ listStyle: "none", padding: 0 }}>
                {(announcements ?? []).map((announcement) => (
                    <li key={announcement._id} style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}>
                        <strong>{announcement.title}</strong>
                        <div style={{ color: "#666" }}>{announcement.body}</div>
                    </li>
                ))}
            </ul>
        </main>
    );
};
