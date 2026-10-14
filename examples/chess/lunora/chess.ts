/**
 * A complete, dependency-free chess rules engine.
 *
 * It lives in `lunora/` on purpose: the server is the only authority on what a
 * legal move is. The browser runs the same functions to grey out illegal
 * squares, but the mutation re-validates from the stored position, so a client
 * that lies is simply rejected. Never trust a move the client says is legal.
 *
 * The whole position serialises to JSON and rides in one `games.position`
 * column. Chess positions are tiny (well under a kilobyte), so the alternative —
 * replaying the move list on every read — buys nothing.
 */

/** A square name like `e4`. */
const AH_RE = /^[a-h][1-8]$/u;

export type PieceType = "B" | "K" | "N" | "P" | "Q" | "R";
export type PieceColor = "black" | "white";

export interface ChessPiece {
    color: PieceColor;
    type: PieceType;
}

export interface Square {
    col: number;
    row: number;
}

export interface CastlingRights {
    blackKingSide: boolean;
    blackQueenSide: boolean;
    whiteKingSide: boolean;
    whiteQueenSide: boolean;
}

export interface ChessState {
    /** 8×8, `board[row][col]`; row 0 is black's back rank. */
    board: (ChessPiece | null)[][];
    castlingRights: CastlingRights;
    currentTurn: PieceColor;
    /** The square a pawn may capture onto this turn, or `null`. */
    enPassantTarget: Square | null;
    fullMoveNumber: number;
    /** Plies since the last capture or pawn move, for the fifty-move rule. */
    halfMoveClock: number;
    isCheck: boolean;
    isCheckmate: boolean;
    isDraw: boolean;
    isStalemate: boolean;
}

export interface ChessMove {
    from: Square;
    promotion?: PieceType;
    to: Square;
}

const BACK_RANK: PieceType[] = ["R", "N", "B", "Q", "K", "B", "N", "R"];
/** The eight squares a king can step to, as (row, col) deltas. */
const KING_OFFSETS: [number, number][] = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 0],
    [1, 1],
];

const KNIGHT_OFFSETS = [
    [-2, -1],
    [-2, 1],
    [-1, -2],
    [-1, 2],
    [1, -2],
    [1, 2],
    [2, -1],
    [2, 1],
];
const STRAIGHTS = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
];
const DIAGONALS = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
];
const PROMOTION_PIECES: PieceType[] = ["Q", "R", "B", "N"];
/** Plies, not moves: 50 full moves by each side. */
const FIFTY_MOVE_PLIES = 100;

const opposite = (color: PieceColor): PieceColor => (color === "white" ? "black" : "white");

const onBoard = (row: number, col: number): boolean => row >= 0 && row < 8 && col >= 0 && col < 8;

/** `{ row: 6, col: 4 }` → `"e2"`. */
export const squareToName = (square: Square): string => `${String.fromCodePoint(97 + square.col)}${String(8 - square.row)}`;

/** `"e2"` → `{ row: 6, col: 4 }`. Callers validate the shape first. */
export const nameToSquare = (name: string): Square => {
    return { col: (name.codePointAt(0) ?? 97) - 97, row: 8 - Number.parseInt(name[1], 10) };
};

export const isSquareName = (name: string): boolean => AH_RE.test(name);

export const createInitialState = (): ChessState => {
    const board: (ChessPiece | null)[][] = Array.from({ length: 8 }, () => Array.from<ChessPiece | null>({ length: 8 }).fill(null));

    for (let col = 0; col < 8; col += 1) {
        board[0][col] = { color: "black", type: BACK_RANK[col] };
        board[1][col] = { color: "black", type: "P" };
        board[6][col] = { color: "white", type: "P" };
        board[7][col] = { color: "white", type: BACK_RANK[col] };
    }

    return {
        board,
        castlingRights: { blackKingSide: true, blackQueenSide: true, whiteKingSide: true, whiteQueenSide: true },
        currentTurn: "white",
        enPassantTarget: null,
        fullMoveNumber: 1,
        halfMoveClock: 0,
        isCheck: false,
        isCheckmate: false,
        isDraw: false,
        isStalemate: false,
    };
};

const findKing = (board: (ChessPiece | null)[][], color: PieceColor): Square | null => {
    for (let row = 0; row < 8; row += 1) {
        for (let col = 0; col < 8; col += 1) {
            const piece = board[row][col];

            if (piece?.type === "K" && piece.color === color) {
                return { col, row };
            }
        }
    }

    return null;
};

/**
 * Is `(row, col)` attacked by `byColor`?
 *
 * Written as an outward scan from the square rather than a sweep over every
 * enemy piece: it is the inner loop of legality checking (every candidate move
 * is simulated and then tested), so it stays proportional to the board's rays,
 * not to the piece count.
 */
/** Is `byColor` attacking (row, col) with a piece that steps rather than slides? */
const isSteppedAttack = (board: (ChessPiece | null)[][], row: number, col: number, byColor: PieceColor): boolean => {
    // Pawns attack diagonally forward, so an attacker sits one rank *behind*
    // the square from the defender's point of view.
    const pawnRow = row + (byColor === "white" ? 1 : -1);
    const pawnSquares: [number, number][] = [-1, 1].map((deltaCol) => [pawnRow, col + deltaCol]);
    const knightSquares: [number, number][] = KNIGHT_OFFSETS.map(([deltaRow, deltaCol]) => [row + deltaRow, col + deltaCol]);
    const kingSquares: [number, number][] = KING_OFFSETS.map(([deltaRow, deltaCol]) => [row + deltaRow, col + deltaCol]);

    const occupant = ([squareRow, squareCol]: [number, number]): ChessPiece | null => (onBoard(squareRow, squareCol) ? board[squareRow][squareCol] : null);
    const held = (squares: [number, number][], type: PieceType): boolean =>
        squares.some((square) => {
            const piece = occupant(square);

            return piece?.type === type && piece.color === byColor;
        });

    return held(pawnSquares, "P") || held(knightSquares, "N") || held(kingSquares, "K");
};

/** Walking one ray from (row, col): does the first piece on it attack the square? */
const rayHasAttacker = (
    board: (ChessPiece | null)[][],
    row: number,
    col: number,
    [deltaRow, deltaCol]: number[],
    byColor: PieceColor,
    slider: PieceType,
): boolean => {
    for (let step = 1; step < 8; step += 1) {
        const nextRow = row + deltaRow * step;
        const nextCol = col + deltaCol * step;

        if (!onBoard(nextRow, nextCol)) {
            return false;
        }

        const piece = board[nextRow][nextCol];

        if (piece) {
            return piece.color === byColor && (piece.type === slider || piece.type === "Q");
        }
    }

    return false;
};

/** Is `byColor` attacking (row, col) along a rank, file or diagonal? */
const isSlidingAttack = (board: (ChessPiece | null)[][], row: number, col: number, byColor: PieceColor): boolean => {
    const rays: [number[][], PieceType][] = [
        [STRAIGHTS, "R"],
        [DIAGONALS, "B"],
    ];

    return rays.some(([directions, slider]) => directions.some((direction) => rayHasAttacker(board, row, col, direction, byColor, slider)));
};

const isSquareAttacked = (board: (ChessPiece | null)[][], row: number, col: number, byColor: PieceColor): boolean =>
    isSteppedAttack(board, row, col, byColor) || isSlidingAttack(board, row, col, byColor);

const isInCheck = (board: (ChessPiece | null)[][], color: PieceColor): boolean => {
    const king = findKing(board, color);

    return king ? isSquareAttacked(board, king.row, king.col, opposite(color)) : false;
};

/** Push `to` as a move when it is on the board and not occupied by one's own piece. */
const pushMove = (moves: ChessMove[], board: (ChessPiece | null)[][], from: Square, to: Square, mover: PieceColor, promotion?: PieceType): void => {
    if (!onBoard(to.row, to.col)) {
        return;
    }

    if (board[to.row][to.col]?.color !== mover) {
        moves.push({ from, promotion, to });
    }
};

/** Walk each ray until the board edge, an own piece, or one capture. */
const slideRays = (moves: ChessMove[], board: (ChessPiece | null)[][], row: number, col: number, mover: PieceColor, directions: number[][]): void => {
    for (const [deltaRow, deltaCol] of directions) {
        for (let step = 1; step < 8; step += 1) {
            const nextRow = row + deltaRow * step;
            const nextCol = col + deltaCol * step;

            if (!onBoard(nextRow, nextCol)) {
                break;
            }

            const target = board[nextRow][nextCol];

            if (target) {
                if (target.color !== mover) {
                    pushMove(moves, board, { col, row }, { col: nextCol, row: nextRow }, mover);
                }

                break;
            }

            pushMove(moves, board, { col, row }, { col: nextCol, row: nextRow }, mover);
        }
    }
};

/** Add the castling move for one side, when the right survives and the path is clear and unattacked. */
const addCastle = (moves: ChessMove[], board: (ChessPiece | null)[][], rank: number, kingSide: boolean, allowed: boolean, enemy: PieceColor): void => {
    const rookCol = kingSide ? 7 : 0;
    const between = kingSide ? [5, 6] : [1, 2, 3];
    const crossed = kingSide ? [4, 5, 6] : [4, 3, 2];

    if (!allowed || board[rank][rookCol]?.type !== "R") {
        return;
    }

    if (between.some((square) => board[rank][square]) || crossed.some((square) => isSquareAttacked(board, rank, square, enemy))) {
        return;
    }

    moves.push({ from: { col: 4, row: rank }, to: { col: kingSide ? 6 : 2, row: rank } });
};

/** King steps plus the two castles, when the rights survive and the path is clear. */
const addKingMoves = (
    state: ChessState,
    row: number,
    col: number,
    piece: ChessPiece,
    add: (toRow: number, toCol: number, promotion?: PieceType) => void,
    castleIfClear: (rank: number, kingSide: boolean, allowed: boolean) => void,
): void => {
    for (const [deltaRow, deltaCol] of KING_OFFSETS) {
        add(row + deltaRow, col + deltaCol);
    }

    if (piece.color === "white" && row === 7 && col === 4) {
        castleIfClear(7, true, state.castlingRights.whiteKingSide);
        castleIfClear(7, false, state.castlingRights.whiteQueenSide);
    } else if (piece.color === "black" && row === 0 && col === 4) {
        castleIfClear(0, true, state.castlingRights.blackKingSide);
        castleIfClear(0, false, state.castlingRights.blackQueenSide);
    }
};

/** One diagonal pawn capture: an enemy piece, or the en-passant square. */
const addPawnCapture = (
    state: ChessState,
    toRow: number,
    toCol: number,
    enemy: PieceColor,
    add: (row: number, col: number) => void,
    addMaybePromoting: (row: number, col: number) => void,
): void => {
    if (!onBoard(toRow, toCol)) {
        return;
    }

    if (state.board[toRow][toCol]?.color === enemy) {
        addMaybePromoting(toRow, toCol);
    }

    if (state.enPassantTarget?.row === toRow && state.enPassantTarget.col === toCol) {
        add(toRow, toCol);
    }
};

/** One push, the two-square opener, both captures, promotions and en passant. */
const addPawnMoves = (
    state: ChessState,
    row: number,
    col: number,
    piece: ChessPiece,
    enemy: PieceColor,
    add: (toRow: number, toCol: number, promotion?: PieceType) => void,
): void => {
    const { board } = state;
    const direction = piece.color === "white" ? -1 : 1;
    const startRow = piece.color === "white" ? 6 : 1;
    const promotionRow = piece.color === "white" ? 0 : 7;

    const addMaybePromoting = (toRow: number, toCol: number): void => {
        if (toRow === promotionRow) {
            for (const promotion of PROMOTION_PIECES) {
                add(toRow, toCol, promotion);
            }

            return;
        }

        add(toRow, toCol);
    };

    if (onBoard(row + direction, col) && !board[row + direction][col]) {
        addMaybePromoting(row + direction, col);

        if (row === startRow && !board[row + direction * 2][col]) {
            add(row + direction * 2, col);
        }
    }

    for (const deltaCol of [-1, 1]) {
        addPawnCapture(state, row + direction, col + deltaCol, enemy, add, addMaybePromoting);
    }
};

/** Pseudo-legal moves for one piece — everything the piece can reach, ignoring whether it exposes its own king. */
const getRawMoves = (state: ChessState, row: number, col: number): ChessMove[] => {
    const { board } = state;
    const piece = board[row][col];

    if (!piece) {
        return [];
    }

    const moves: ChessMove[] = [];
    const enemy = opposite(piece.color);

    const add = (toRow: number, toCol: number, promotion?: PieceType): void => {
        pushMove(moves, board, { col, row }, { col: toCol, row: toRow }, piece.color, promotion);
    };

    const slide = (directions: number[][]): void => {
        slideRays(moves, board, row, col, piece.color, directions);
    };

    const castleIfClear = (rank: number, kingSide: boolean, allowed: boolean): void => {
        addCastle(moves, board, rank, kingSide, allowed, enemy);
    };

    switch (piece.type) {
        case "B": {
            slide(DIAGONALS);
            break;
        }

        case "K": {
            addKingMoves(state, row, col, piece, add, castleIfClear);
            break;
        }

        case "N": {
            for (const [deltaRow, deltaCol] of KNIGHT_OFFSETS) {
                add(row + deltaRow, col + deltaCol);
            }

            break;
        }

        case "P": {
            addPawnMoves(state, row, col, piece, enemy, add);
            break;
        }

        case "Q": {
            slide([...STRAIGHTS, ...DIAGONALS]);
            break;
        }

        case "R": {
            slide(STRAIGHTS);
            break;
        }
        // Every piece type is covered above; a default keeps the switch total.
        default: {
            break;
        }
    }

    return moves;
};

/** Apply a move to a board copy without touching state bookkeeping — the shared core of legality testing and {@link applyMove}. */
const moveOnBoard = (state: ChessState, move: ChessMove): { board: (ChessPiece | null)[][]; captured: ChessPiece | null; special?: string } => {
    const board = state.board.map((rank) => [...rank]);
    const piece = board[move.from.row][move.from.col];

    if (!piece) {
        throw new Error("no piece on the source square");
    }

    let captured = board[move.to.row][move.to.col];
    let special: string | undefined;

    board[move.to.row][move.to.col] = move.promotion ? { color: piece.color, type: move.promotion } : piece;
    board[move.from.row][move.from.col] = null;

    if (move.promotion) {
        special = `promotion:${move.promotion}`;
    }

    if (piece.type === "K" && Math.abs(move.to.col - move.from.col) === 2) {
        const kingSide = move.to.col > move.from.col;

        board[move.to.row][kingSide ? 5 : 3] = board[move.to.row][kingSide ? 7 : 0];
        board[move.to.row][kingSide ? 7 : 0] = null;
        special = kingSide ? "castle:kingside" : "castle:queenside";
    }

    // En passant: the captured pawn is beside the moving pawn's origin, not on
    // the destination square, so it has to be cleared explicitly.
    if (piece.type === "P" && move.to.row === state.enPassantTarget?.row && move.to.col === state.enPassantTarget.col) {
        captured = board[move.from.row][move.to.col];
        board[move.from.row][move.to.col] = null;
        special = "en_passant";
    }

    return { board, captured, special };
};

/** Every legal move for the piece on `(row, col)` — pseudo-legal moves minus the ones that leave the mover's king in check. */
export const getValidMoves = (state: ChessState, row: number, col: number): ChessMove[] => {
    const piece = state.board[row][col];

    if (piece?.color !== state.currentTurn) {
        return [];
    }

    return getRawMoves(state, row, col).filter((move) => !isInCheck(moveOnBoard(state, move).board, piece.color));
};

const hasAnyLegalMove = (state: ChessState): boolean => {
    for (let row = 0; row < 8; row += 1) {
        for (let col = 0; col < 8; col += 1) {
            if (state.board[row][col]?.color === state.currentTurn && getValidMoves(state, row, col).length > 0) {
                return true;
            }
        }
    }

    return false;
};

/** Castling rights after a move: the king losing both, and either corner square being touched. */
const rightsAfter = (current: CastlingRights, piece: ChessPiece, move: ChessMove): CastlingRights => {
    const rights = { ...current };

    if (piece.type === "K") {
        if (piece.color === "white") {
            rights.whiteKingSide = false;
            rights.whiteQueenSide = false;
        } else {
            rights.blackKingSide = false;
            rights.blackQueenSide = false;
        }
    }

    // A rook leaving *or* being captured on its home square ends that side's
    // castling right; both are keyed off the corner squares.
    const corners: [number, number, keyof CastlingRights][] = [
        [7, 0, "whiteQueenSide"],
        [7, 7, "whiteKingSide"],
        [0, 0, "blackQueenSide"],
        [0, 7, "blackKingSide"],
    ];

    for (const { col, row } of [move.from, move.to]) {
        for (const [cornerRow, cornerCol, right] of corners) {
            if (row === cornerRow && col === cornerCol) {
                rights[right] = false;
            }
        }
    }

    return rights;
};

/** The position after `move`, with check / checkmate / stalemate / draw already resolved for the side to move. */
export const applyMove = (state: ChessState, move: ChessMove): ChessState => {
    const piece = state.board[move.from.row][move.from.col];

    if (!piece) {
        throw new Error("no piece on the source square");
    }

    const { board, captured } = moveOnBoard(state, move);
    const castlingRights = rightsAfter(state.castlingRights, piece, move);

    const halfMoveClock = piece.type === "P" || captured ? 0 : state.halfMoveClock + 1;

    const next: ChessState = {
        board,
        castlingRights,
        currentTurn: opposite(state.currentTurn),
        enPassantTarget:
            piece.type === "P" && Math.abs(move.to.row - move.from.row) === 2 ? { col: move.from.col, row: (move.from.row + move.to.row) / 2 } : null,
        fullMoveNumber: state.currentTurn === "black" ? state.fullMoveNumber + 1 : state.fullMoveNumber,
        halfMoveClock,
        isCheck: false,
        isCheckmate: false,
        isDraw: halfMoveClock >= FIFTY_MOVE_PLIES,
        isStalemate: false,
    };

    next.isCheck = isInCheck(board, next.currentTurn);

    if (!hasAnyLegalMove(next)) {
        if (next.isCheck) {
            next.isCheckmate = true;
        } else {
            next.isStalemate = true;
            next.isDraw = true;
        }
    }

    return next;
};

/**
 * Is `move` legal in `state`?
 *
 * A promoting move must name the piece it promotes to. Treating an absent
 * `promotion` as "matches any candidate" would accept a pawn push onto the back
 * rank with no promotion — and `applyMove` would then leave a *pawn* on rank 0
 * or 7, a piece with no legal moves from there, quietly corrupting every later
 * checkmate and stalemate evaluation. The browser always sends a piece, so only
 * a hand-made request reaches this.
 */
export const isValidMove = (state: ChessState, move: ChessMove): boolean =>
    getValidMoves(state, move.from.row, move.from.col).some((candidate) => {
        if (candidate.to.row !== move.to.row || candidate.to.col !== move.to.col) {
            return false;
        }

        // `candidate.promotion` is set on exactly the moves that promote, so
        // this compares the requirement against what the caller supplied.
        return candidate.promotion === move.promotion;
    });

/** Algebraic notation for a move. Disambiguation is by file only — enough for a readable move list, short of full SAN. */
export const getMoveNotation = (state: ChessState, move: ChessMove): string => {
    const piece = state.board[move.from.row][move.from.col];

    if (!piece) {
        return "";
    }

    if (piece.type === "K" && Math.abs(move.to.col - move.from.col) === 2) {
        return move.to.col > move.from.col ? "O-O" : "O-O-O";
    }

    const from = squareToName(move.from);
    const target = state.enPassantTarget;
    const isEnPassant = piece.type === "P" && target !== null && target.row === move.to.row && target.col === move.to.col;
    const isCapture = Boolean(state.board[move.to.row][move.to.col]) || isEnPassant;

    let notation = piece.type === "P" ? "" : piece.type;

    if (piece.type !== "P" && piece.type !== "K") {
        notation += from[0];
    }

    if (isCapture) {
        notation += piece.type === "P" ? `${from[0]}x` : "x";
    }

    notation += squareToName(move.to);

    if (move.promotion) {
        notation += `=${move.promotion}`;
    }

    const after = applyMove(state, move);

    const suffix = after.isCheckmate ? "#" : "";
    const check = suffix || (after.isCheck ? "+" : "");

    return notation + check;
};

export const serializeState = (state: ChessState): string => JSON.stringify(state);

export const deserializeState = (json: string): ChessState => JSON.parse(json) as ChessState;

export const getGameResult = (state: ChessState): "black_wins" | "draw" | "white_wins" | null => {
    if (state.isCheckmate) {
        return state.currentTurn === "white" ? "black_wins" : "white_wins";
    }

    return state.isDraw ? "draw" : null;
};
