import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { authClient } from "./auth-client.js";
import { Channel } from "./Channel.js";
import { SignIn } from "./SignIn.js";

export const App = (): ReactElement => {
    const session = authClient.useSession();
    const user = session.data?.user as undefined | { email: string; id: string; name?: string };

    if (!user) {
        return <SignIn />;
    }

    return <Chat email={user.email} name={user.name ?? user.email} userId={user.id} />;
};

interface ChatProperties {
    email: string;
    name: string;
    userId: string;
}

const Chat = ({ email, name, userId }: ChatProperties): ReactElement => {
    const channels = useQuery(api.channels.list, {});
    const profiles = useQuery(api.profiles.list, {});

    const { mutate: createChannel } = useMutation(api.channels.create);
    const { mutate: saveProfile } = useMutation(api.profiles.save);

    const [active, setActive] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Publish a display name the first time this account is seen, so other
    // members' clients can resolve it. `profiles.save` upserts, so a repeat is
    // harmless; the ref just avoids writing on every render pass.
    const claimedRef = useRef(false);

    useEffect(() => {
        if (claimedRef.current || profiles === undefined || profiles.some((profile) => profile.userId === userId)) {
            return;
        }

        claimedRef.current = true;
        void saveProfile({ name });
    }, [profiles, name, saveProfile, userId]);

    const current = active ?? channels?.[0]?.name ?? null;

    return (
        <div className="shell">
            <aside className="sidebar">
                <header>
                    <strong>Channels</strong>
                </header>

                <ul>
                    {(channels ?? []).map((channel) => (
                        <li key={channel._id}>
                            <button aria-pressed={channel.name === current} onClick={() => setActive(channel.name)} type="button">
                                #{channel.name}
                            </button>
                        </li>
                    ))}
                </ul>

                <form
                    onSubmit={(event) => {
                        event.preventDefault();

                        const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
                        const value = input.value.trim();

                        if (!value) {
                            return;
                        }

                        setError(null);
                        void createChannel({ name: value })
                            .then(() => {
                                setActive(value.toLowerCase());
                                input.value = "";
                            })
                            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "could not create channel"));
                    }}
                >
                    <input aria-label="New channel" name="name" placeholder="new-channel" />
                </form>

                {error && <p className="error">{error}</p>}

                <footer>
                    <span className="muted">{email}</span>
                    <button className="link" onClick={() => void authClient.signOut()} type="button">
                        Sign out
                    </button>
                </footer>
            </aside>

            {current ? (
                <Channel channelId={current} displayName={name} profiles={profiles ?? []} userId={userId} />
            ) : (
                <main className="empty">
                    <p className="muted">{channels === undefined ? "Connecting…" : "Create a channel to get started."}</p>
                </main>
            )}
        </div>
    );
};
