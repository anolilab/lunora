import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc, Id } from "../../lunora/_generated/dataModel.js";
import { authClient } from "./auth-client.js";
import { Game } from "./Game.js";
import { SignIn } from "./SignIn.js";

export const App = (): ReactElement => {
    const session = authClient.useSession();
    const user = session.data?.user as undefined | { email: string; id: string; name?: string };

    if (!user) {
        return <SignIn />;
    }

    return <Lobby displayName={user.name ?? user.email.split("@")[0]} userId={user.id} />;
};

interface LobbyProperties {
    displayName: string;
    userId: string;
}

const Lobby = ({ displayName, userId }: LobbyProperties): ReactElement => {
    const me = useQuery(api.players.me, {});
    const players = useQuery(api.players.list, {});
    const leaderboard = useQuery(api.players.leaderboard, {});
    const openLobbies = useQuery(api.lobby.listOpen, {});
    const myLobby = useQuery(api.lobby.mine, {});
    const active = useQuery(api.games.listActive, {});

    const { mutate: claim } = useMutation(api.players.claim);
    const { mutate: quickMatch } = useMutation(api.lobby.quickMatch);
    const { mutate: createLobby } = useMutation(api.lobby.create);
    const { mutate: joinLobby } = useMutation(api.lobby.join);
    const { mutate: joinByCode } = useMutation(api.lobby.joinByCode);
    const { mutate: leaveLobby } = useMutation(api.lobby.leave);
    const { mutate: startGame } = useMutation(api.games.start);

    const [watching, setWatching] = useState<Id<"games"> | null>(null);
    const [error, setError] = useState<string | null>(null);

    const claimedRef = useRef(false);

    useEffect(() => {
        if (claimedRef.current || me === undefined || me !== null) {
            return;
        }

        claimedRef.current = true;
        void claim({ displayName });
    }, [me, claim, displayName]);

    const nameOf = useMemo(() => {
        const byUser = new Map((players ?? []).map((player) => [player.userId, player.displayName]));

        return (id: string): string => byUser.get(id) ?? "Unknown";
    }, [players]);

    // The host writes `gameId` onto the lobby when they start, and every seat at
    // that lobby is subscribed to it — so the guest lands in the game without
    // polling for it.
    const myGame = myLobby?.gameId ?? null;
    const open = watching ?? myGame;

    const run = (work: Promise<unknown>): void => {
        setError(null);
        void work.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "something went wrong"));
    };

    if (open) {
        return (
            <main className="page">
                <Game
                    gameId={open}
                    nameOf={nameOf}
                    onLeave={() => {
                        setWatching(null);

                        if (myLobby && !watching) {
                            void leaveLobby({ lobbyId: myLobby._id });
                        }
                    }}
                    userId={userId}
                />
            </main>
        );
    }

    return (
        <main className="page">
            <header className="page-header">
                <div>
                    <h1>Lunora Chess</h1>
                    <p className="muted">{me ? `${me.displayName} · ${me.rating} Elo · ${me.gamesWon}/${me.gamesPlayed} won` : "Setting up your profile…"}</p>
                </div>

                <button className="link" onClick={() => void authClient.signOut()} type="button">
                    Sign out
                </button>
            </header>

            {error && <p className="error">{error}</p>}

            {myLobby ? (
                <section className="card">
                    <h2>Your table</h2>
                    <p className="muted">
                        {myLobby.guestId ? `${nameOf(myLobby.hostId)} vs ${nameOf(myLobby.guestId)}` : "Waiting for an opponent…"}
                        {myLobby.inviteCode && ` · code ${myLobby.inviteCode}`}
                    </p>

                    <div className="row">
                        {myLobby.isHost && myLobby.guestId && (
                            <button className="primary" onClick={() => run(startGame({ lobbyId: myLobby._id }))} type="button">
                                Start game
                            </button>
                        )}
                        <button onClick={() => run(leaveLobby({ lobbyId: myLobby._id }))} type="button">
                            Leave
                        </button>
                    </div>
                </section>
            ) : (
                <section className="card">
                    <h2>Play</h2>

                    <div className="row">
                        <button className="primary" onClick={() => run(quickMatch({}))} type="button">
                            Quick match
                        </button>
                        <button onClick={() => run(createLobby({ isPrivate: true }))} type="button">
                            Private table
                        </button>
                    </div>

                    <form
                        onSubmit={(event) => {
                            event.preventDefault();

                            const input = event.currentTarget.elements.namedItem("code") as HTMLInputElement;

                            if (input.value.trim()) {
                                run(joinByCode({ inviteCode: input.value.trim() }));
                            }
                        }}
                    >
                        <input aria-label="Invite code" name="code" placeholder="Invite code" />
                    </form>
                </section>
            )}

            <section className="card">
                <h2>Open tables</h2>

                <ul className="list">
                    {(openLobbies ?? []).map((lobby) => (
                        <li key={lobby._id}>
                            <span>{nameOf(lobby.hostId)}</span>
                            {lobby.hostId !== userId && (
                                <button onClick={() => run(joinLobby({ lobbyId: lobby._id }))} type="button">
                                    Sit down
                                </button>
                            )}
                        </li>
                    ))}
                    {openLobbies?.length === 0 && <li className="muted">Nobody is waiting. Open a table.</li>}
                </ul>
            </section>

            <section className="card">
                <h2>Watch a game</h2>

                <ul className="list">
                    {(active ?? []).map((game) => (
                        <li key={game._id}>
                            <span>
                                {nameOf(game.whiteId)} vs {nameOf(game.blackId)} · {game.moveCount} moves
                            </span>
                            <button onClick={() => setWatching(game._id)} type="button">
                                Watch
                            </button>
                        </li>
                    ))}
                    {active?.length === 0 && <li className="muted">No games in progress.</li>}
                </ul>
            </section>

            <section className="card">
                <h2>Leaderboard</h2>

                <ol className="list">
                    {(leaderboard ?? []).map((player) => (
                        <li key={player._id}>
                            <span>{player.displayName}</span>
                            <span className="muted">
                                {player.rating} · {player.gamesWon}/{player.gamesPlayed}
                            </span>
                        </li>
                    ))}
                </ol>
            </section>
        </main>
    );
};
