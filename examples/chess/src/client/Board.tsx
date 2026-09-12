import type { ReactElement } from "react";
import { useState } from "react";

import type { ChessMove, ChessState, PieceColor, PieceType, Square } from "../../lunora/chess.js";
import { getValidMoves, squareToName } from "../../lunora/chess.js";

/**
 * Callback ref that opens the dialog as it attaches.
 *
 * A native `<dialog>` is modal only once `showModal()` runs, and the choice
 * really is modal: the move is not legal until a piece is named. The element is
 * rendered only while a promotion is pending, so attaching IS the moment to open
 * it — which is why this is a ref rather than an effect watching the state.
 *
 * Module scope keeps its identity stable, so React invokes it on attach and
 * detach rather than on every render.
 */
const openAsModal = (node: HTMLDialogElement | null): void => {
    node?.showModal();
};

/** `[0…7]` — board indices, reversed when Black is looking at it. */
const RANKS = Array.from({ length: 8 }, (_, index) => index);

/** Screen readers announce this, so it spells the piece out — "e2 white pawn", not "e2 white P". */
const PIECE_NAMES: Record<PieceType, string> = { B: "bishop", K: "king", N: "knight", P: "pawn", Q: "queen", R: "rook" };

const GLYPHS: Record<PieceColor, Record<PieceType, string>> = {
    black: { B: "♝", K: "♚", N: "♞", P: "♟", Q: "♛", R: "♜" },
    white: { B: "♗", K: "♔", N: "♘", P: "♙", Q: "♕", R: "♖" },
};

const PROMOTIONS: PieceType[] = ["Q", "R", "B", "N"];

interface BoardProperties {
    /** `null` while spectating — the board is then read-only. */
    myColor: PieceColor | null;
    onMove: (from: string, to: string, promotion?: PieceType) => void;
    position: ChessState;
}

/**
 * The board.
 *
 * It runs the same engine the server does, purely so the legal squares light up
 * as you pick a piece. Nothing here is trusted: `games.makeMove` re-derives
 * legality from the stored position, so the worst a hacked board can do is get
 * its move rejected.
 */
export const Board = ({ myColor, onMove, position }: BoardProperties): ReactElement => {
    const [selected, setSelected] = useState<Square | null>(null);
    const [pendingPromotion, setPendingPromotion] = useState<ChessMove | null>(null);

    const myTurn = myColor !== null && position.currentTurn === myColor;
    const legal = selected ? getValidMoves(position, selected.row, selected.col) : [];

    // Black sees the board from its own side.
    const ranks = myColor === "black" ? RANKS.toReversed() : RANKS;
    const files = myColor === "black" ? RANKS.toReversed() : RANKS;

    const onSquare = (row: number, col: number): void => {
        if (!myTurn) {
            return;
        }

        const target = legal.find((move) => move.to.row === row && move.to.col === col);

        if (target) {
            // A promoting pawn produces four candidate moves for the same
            // square; ask which piece before sending one.
            if (legal.some((move) => move.to.row === row && move.to.col === col && move.promotion)) {
                setPendingPromotion(target);
            } else {
                onMove(squareToName(target.from), squareToName(target.to));
                setSelected(null);
            }

            return;
        }

        setSelected(position.board[row][col]?.color === myColor ? { col, row } : null);
    };

    return (
        <div className="board-wrap">
            <div className="board">
                {ranks.map((row) =>
                    files.map((col) => {
                        const piece = position.board[row][col];
                        const isTarget = legal.some((move) => move.to.row === row && move.to.col === col);
                        const isSelected = selected?.row === row && selected.col === col;

                        return (
                            <button
                                aria-label={`${squareToName({ col, row })}${piece ? ` ${piece.color} ${PIECE_NAMES[piece.type]}` : ""}`}
                                className={["square", (row + col) % 2 === 0 ? "light" : "dark", isSelected ? "selected" : "", isTarget ? "target" : ""]
                                    .filter(Boolean)
                                    .join(" ")}
                                disabled={!myTurn}
                                key={`${String(row)}-${String(col)}`}
                                onClick={() => {
                                    onSquare(row, col);
                                }}
                                type="button"
                            >
                                {piece ? GLYPHS[piece.color][piece.type] : ""}
                            </button>
                        );
                    }),
                )}
            </div>

            {pendingPromotion && (
                <dialog aria-label="Choose a promotion piece" className="promotion" ref={openAsModal}>
                    {PROMOTIONS.map((choice) => (
                        <button
                            key={choice}
                            onClick={() => {
                                onMove(squareToName(pendingPromotion.from), squareToName(pendingPromotion.to), choice);
                                setPendingPromotion(null);
                                setSelected(null);
                            }}
                            type="button"
                        >
                            {GLYPHS[position.currentTurn][choice]}
                        </button>
                    ))}
                </dialog>
            )}
        </div>
    );
};
