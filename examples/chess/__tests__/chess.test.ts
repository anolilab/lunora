import { describe, expect, it } from "vitest";

import type { ChessState } from "../lunora/chess";
import { applyMove, createInitialState, getGameResult, getMoveNotation, getValidMoves, isValidMove, nameToSquare } from "../lunora/chess";

/** Play a list of `"e2e4"`-style moves, asserting each one is legal. */
const play = (moves: string[], from: ChessState = createInitialState()): ChessState =>
    moves.reduce((state, move) => {
        const step = {
            from: nameToSquare(move.slice(0, 2)),
            promotion: move.includes("=") ? (move.at(-1) as "N" | "Q") : undefined,
            to: nameToSquare(move.slice(2, 4)),
        };

        expect(isValidMove(state, step), `${move} should be legal`).toBe(true);

        return applyMove(state, step);
    }, from);

describe("chess engine", () => {
    it("opens with twenty legal moves for white", () => {
        const state = createInitialState();
        let count = 0;

        for (let row = 0; row < 8; row += 1) {
            for (let col = 0; col < 8; col += 1) {
                count += getValidMoves(state, row, col).length;
            }
        }

        expect(count).toBe(20);
    });

    it("rejects a move by the side that is not to play", () => {
        expect(isValidMove(createInitialState(), { from: nameToSquare("e7"), to: nameToSquare("e5") })).toBe(false);
    });

    it("ends the game on checkmate", () => {
        // Fool's mate.
        const state = play(["f2f3", "e7e5", "g2g4", "d8h4"]);

        expect(state.isCheck).toBe(true);
        expect(state.isCheckmate).toBe(true);
        expect(getGameResult(state)).toBe("black_wins");
    });

    it("will not let a pinned piece expose its own king", () => {
        // The d2 pawn is pinned along the e1–a5 diagonal by the bishop on b4.
        const state = play(["e2e4", "e7e5", "d2d3", "f8b4"]);

        expect(isValidMove(state, { from: nameToSquare("d3"), to: nameToSquare("d4") })).toBe(false);
    });

    it("castles king-side and moves the rook with the king", () => {
        const state = play(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1"]);

        expect(state.board[7][6]).toStrictEqual({ color: "white", type: "K" });
        expect(state.board[7][5]).toStrictEqual({ color: "white", type: "R" });
        expect(state.castlingRights.whiteKingSide).toBe(false);
    });

    it("captures en passant, removing the pawn beside the mover", () => {
        const state = play(["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"]);

        // The black d5 pawn is gone even though white landed on d6.
        expect(state.board[3][3]).toBeNull();
        expect(state.board[2][3]).toStrictEqual({ color: "white", type: "P" });
    });

    it("promotes a pawn to the requested piece", () => {
        const state = play(["a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "h7h6", "a6a7", "h6h5", "a7b8=N"]);

        // The pawn captured the knight on b8 and became a knight itself.
        expect(state.board[0][1]).toStrictEqual({ color: "white", type: "N" });
    });

    it("writes notation with capture, check and mate markers", () => {
        const start = createInitialState();

        expect(getMoveNotation(start, { from: nameToSquare("g1"), to: nameToSquare("f3") })).toBe("Ngf3");

        const beforeMate = play(["f2f3", "e7e5", "g2g4"]);

        expect(getMoveNotation(beforeMate, { from: nameToSquare("d8"), to: nameToSquare("h4") })).toBe("Qdh4#");
    });

    it("refuses a promoting move that names no piece", () => {
        // 8 from `play` (one per move) + the 2 below.
        expect.assertions(10);

        // The browser always sends a piece, so only a hand-made request gets
        // here — and accepting it leaves a pawn stranded on the back rank,
        // corrupting every later checkmate/stalemate evaluation.
        const state = play(["a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "h7h6", "a6a7", "h6h5"]);
        const bare = { from: nameToSquare("a7"), to: nameToSquare("b8") };

        expect(isValidMove(state, bare)).toBe(false);
        // Naming a piece is what makes the same move legal.
        expect(isValidMove(state, { ...bare, promotion: "Q" })).toBe(true);
    });
});
