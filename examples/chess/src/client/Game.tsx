import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import type { PieceType } from "../../lunora/chess.js";
import { deserializeState } from "../../lunora/chess.js";
import { api } from "../../lunora/_generated/api.js";
import type { Doc, Id } from "../../lunora/_generated/dataModel.js";
import { Board } from "./Board.js";

interface GameProperties {
    gameId: Id<"games">;
    nameOf: (userId: string) => string;
    onLeave: () => void;
    userId: string;
}

const RESULT_LABEL: Record<string, string> = { black_wins: "Black wins", draw: "Draw", white_wins: "White wins" };

export const Game = ({ gameId, nameOf, onLeave, userId }: GameProperties): ReactElement => {
    const game = useQuery(api.games.get, { gameId });
    const moves = useQuery(api.games.moves, { gameId });

    const { error, mutate: makeMove } = useMutation(api.games.makeMove);
    const { mutate: resign } = useMutation(api.games.resign);
    const { mutate: offerDraw } = useMutation(api.games.offerDraw);
    const { mutate: respondToDraw } = useMutation(api.games.respondToDraw);

    if (game === undefined) {
        return <p className="muted">Loading…</p>;
    }

    if (game === null) {
        return (
            <section>
                <button onClick={onLeave} type="button">
                    ← Back
                </button>
                <p className="muted">That game is gone.</p>
            </section>
        );
    }

    const position = deserializeState(game.position);
    // A spectator has no colour, so the board renders read-only for them —
    // watching is just a subscription to the same query the players use.
    const myColor = userId === game.whiteId ? "white" : userId === game.blackId ? "black" : null;
    const drawOfferedToMe = Boolean(game.drawOfferedBy) && game.drawOfferedBy !== userId && myColor !== null;

    const status =
        game.status === "completed" ? (RESULT_LABEL[game.result ?? ""] ?? "Finished") : `${position.currentTurn} to move${position.isCheck ? " · check" : ""}`;

    return (
        <section className="game">
            <header className="game-header">
                <button onClick={onLeave} type="button">
                    ← Back
                </button>

                <div>
                    <strong>
                        {nameOf(game.whiteId)} vs {nameOf(game.blackId)}
                    </strong>
                    <p className="muted">
                        {status}
                        {myColor === null && " · spectating"}
                    </p>
                </div>

                {myColor !== null && game.status === "active" && (
                    <div className="row">
                        <button onClick={() => void offerDraw({ gameId })} type="button">
                            Offer draw
                        </button>
                        <button onClick={() => void resign({ gameId })} type="button">
                            Resign
                        </button>
                    </div>
                )}
            </header>

            {drawOfferedToMe && (
                <div className="banner">
                    <span>{nameOf(game.drawOfferedBy as string)} offers a draw.</span>
                    <button onClick={() => void respondToDraw({ accept: true, gameId })} type="button">
                        Accept
                    </button>
                    <button onClick={() => void respondToDraw({ accept: false, gameId })} type="button">
                        Decline
                    </button>
                </div>
            )}

            {error && <p className="error">{error.message}</p>}

            <div className="game-body">
                <Board
                    myColor={game.status === "active" ? myColor : null}
                    onMove={(from, to, promotion?: PieceType) => void makeMove({ from, gameId, promotion, to })}
                    position={position}
                />

                <ol className="history">
                    {(moves ?? []).map((move) => (
                        <li key={move._id}>
                            <span className="muted">{Math.ceil(move.turnNumber / 2)}.</span> {move.notation}
                        </li>
                    ))}
                </ol>
            </div>
        </section>
    );
};
