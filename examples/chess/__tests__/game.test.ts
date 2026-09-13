/**
 * Boots the real schema and procedures against the in-memory harness, then plays
 * an actual game over the real mutations.
 *
 * `chess.test.ts` covers the move generator in isolation. This file covers the
 * thing that generator cannot: whether the *server* enforces it. Both bugs found
 * while building this example — an illegal move accepted, and a pawn promoted to
 * nothing — were invisible to a pure-logic test and to a browser that always
 * sends well-formed input.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChessState } from "../lunora/chess";
import { get, makeMove, moves, resign, start } from "../lunora/games";
import { create, join, listOpen } from "../lunora/lobby";
import schema from "../lunora/schema";

/** Any coded refusal — the cases below assert WHICH move is refused, not the wording. */
const REJECTED_RE = /.+/u;

const ALREADY_CONFLICT_RE = /already|conflict/i;
const OVER_RE = /over/i;

let t: ReturnType<typeof lunoraTest>;
let white: ReturnType<typeof lunoraTest>;
let black: ReturnType<typeof lunoraTest>;

describe("game lifecycle", () => {
    beforeEach(() => {
        t = lunoraTest(schema);
        white = t.withIdentity({ userId: "u-white" });
        black = t.withIdentity({ userId: "u-black" });
    });

    afterEach(() => {
        t.close();
    });

    /** Host opens a lobby, guest joins, host starts. Returns the game id. */
    const seatedGame = async () => {
        const lobbyId = await white.mutation(create, { isPrivate: false });

        await black.mutation(join, { lobbyId });

        return white.mutation(start, { lobbyId });
    };

    /** The position is stored as one JSON blob, so whose turn it is comes out of there. */
    const turn = async (gameId: string): Promise<string | undefined> => {
        const game = await white.query(get, { gameId: gameId as never });

        return game ? (JSON.parse(game.position) as ChessState).currentTurn : undefined;
    };

    it("seats two players and starts a game with white to move", async () => {
        expect.assertions(4);

        const gameId = await seatedGame();
        const game = await white.query(get, { gameId });

        expect(game?.whiteId).toBe("u-white");
        expect(game?.blackId).toBe("u-black");
        expect(game?.status).toBe("active");
        await expect(turn(gameId)).resolves.toBe("white");
    });

    it("takes an open lobby off the list once it is full", async () => {
        expect.assertions(2);

        const lobbyId = await white.mutation(create, { isPrivate: false });

        await expect(white.query(listOpen, {})).resolves.toHaveLength(1);

        await black.mutation(join, { lobbyId });

        await expect(white.query(listOpen, {})).resolves.toStrictEqual([]);
    });

    it("refuses to start twice, so one lobby can never mint two games", async () => {
        expect.assertions(1);

        const lobbyId = await white.mutation(create, { isPrivate: false });

        await black.mutation(join, { lobbyId });
        await white.mutation(start, { lobbyId });

        await expect(white.mutation(start, { lobbyId })).rejects.toThrow(ALREADY_CONFLICT_RE);
    });

    it("plays a move, records it, and passes the turn", async () => {
        expect.assertions(3);

        const gameId = await seatedGame();

        await white.mutation(makeMove, { from: "e2", gameId, to: "e4" });

        await expect(turn(gameId)).resolves.toBe("black");

        const awaited1 = await white.query(get, { gameId });

        expect(awaited1?.moveCount).toBe(1);

        const awaited2 = await white.query(moves, { gameId });

        expect(awaited2.map((move) => `${move.from}${move.to}`)).toStrictEqual(["e2e4"]);
    });

    it("rejects a move by the player whose turn it is not", async () => {
        expect.assertions(1);

        const gameId = await seatedGame();

        await expect(black.mutation(makeMove, { from: "e7", gameId, to: "e5" })).rejects.toThrow(REJECTED_RE);
    });

    it("rejects a move by someone who is not in the game", async () => {
        expect.assertions(1);

        const gameId = await seatedGame();

        await expect(t.withIdentity({ userId: "u-onlooker" }).mutation(makeMove, { from: "e2", gameId, to: "e4" })).rejects.toThrow(REJECTED_RE);
    });

    /**
     * The regression that mattered: the server accepted a knight teleporting across
     * the board because it wrote the move without ever asking the generator.
     */
    it("rejects an illegal move", async () => {
        expect.assertions(2);

        const gameId = await seatedGame();

        await expect(white.mutation(makeMove, { from: "b1", gameId, to: "h5" })).rejects.toThrow(REJECTED_RE);
        await expect(white.query(moves, { gameId })).resolves.toStrictEqual([]);
    });

    it("rejects a move from an empty square", async () => {
        expect.assertions(1);

        const gameId = await seatedGame();

        await expect(white.mutation(makeMove, { from: "e4", gameId, to: "e5" })).rejects.toThrow(REJECTED_RE);
    });

    it("settles a resignation in the opponent's favour and closes the game", async () => {
        expect.assertions(3);

        const gameId = await seatedGame();

        await white.mutation(resign, { gameId });

        const game = await white.query(get, { gameId });

        expect(game?.status).not.toBe("active");
        expect(game?.result).toBe("black_wins");

        await expect(black.mutation(makeMove, { from: "e7", gameId, to: "e5" })).rejects.toThrow(OVER_RE);
    });
});
