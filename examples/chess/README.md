# @lunora-example/chess

Multiplayer chess: public and private lobbies, live boards, spectators, Elo
ratings, resignations and draw offers — with a complete rules engine running on
the server.

## Deploy it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/chess)

One click clones the repo, provisions the Durable Object namespace and the D1 database, prompts for the secrets in
`.dev.vars.example`, and deploys. Or from a checkout:

```bash
pnpm --filter @lunora-example/chess run deploy
```

## What it demonstrates

- **A server-authoritative game loop.** `lunora/chess.ts` is the only authority
  on what a legal move is. The browser imports the same module so it can light
  up legal squares, but `games.makeMove` re-validates against the stored
  position with `isValidMove` before touching anything. A client that asks for
  a knight to teleport is refused, not obeyed.
- **Serialized mutations as a game rule.** The shard runs mutations one at a
  time against its own SQLite, so "read the position → validate → write the
  position, the move row and both ratings" is a single commit. Two players
  cannot both move against the same position; the losing request sees the
  updated turn and is rejected.
- **Settling in the same transaction.** `ratingUpdates` is a pure function
  applied inline rather than a follow-up mutation, so a crash can never leave a
  finished game with unadjusted ratings.
- **Spectating is just a subscription.** A watcher subscribes to the same
  `games.get` / `games.moves` queries the players do and renders the board
  read-only. There is no separate spectator path.
- **Handing off through a subscribed row.** Starting a game writes `gameId` onto
  the lobby, and the guest — already subscribed to that lobby — lands in the
  game. No polling, no second channel.

## Setup

Auth needs a D1 database; the games themselves do not.

```bash
pnpm install

cp examples/chess/.dev.vars.example examples/chess/.dev.vars    # then edit AUTH_SECRET
wrangler d1 create lunora-example-chess                         # paste the id into wrangler.jsonc

pnpm --filter @lunora-example/chess dev
```

Open <http://localhost:5173> in two browser profiles, create two accounts, hit
**Quick match** in both, then **Start game**. Open a third window and watch it
from the "Watch a game" list.

## Why one shard

Every table is root-scoped: one Durable Object owns every game. A chess game is
a handful of writes a minute, and the single shard buys exactly the property the
game needs — one serialized order of moves, by construction.

The ceiling is roughly 1 000 requests/second for the whole server. Past that,
`.shardBy` a game key so each game gets its own object, keep a small root-scoped
directory for the lobby and spectator lists, and promote `profiles` to
`.global()` since ratings would then have to resolve from inside a game's shard.
`examples/team-chat` shows that layout.

## Key snippet

```ts
// lunora/games.ts — the whole outcome is decided here, from the stored position
const position = deserializeState(game.position);

if (position.currentTurn !== color) {
    throw new LunoraError("CONFLICT", "not your turn");
}

// Load-bearing: `applyMove` moves pieces, it does not judge them.
if (!isValidMove(position, move)) {
    throw new LunoraError("BAD_REQUEST", `illegal move: ${from}${to}`);
}

const notation = getMoveNotation(position, move); // read before the move
const next = applyMove(position, move);
const result = getGameResult(next);
```

Note that these coded errors currently reach the browser as a generic
`INTERNAL` / "Internal error" — a `LunoraError` thrown inside a shard function
loses its code on the way out. The move is still refused; the client just cannot
branch on _why_ yet.

## Tests

```bash
pnpm --filter @lunora-example/chess test
```

Covers the engine: legal move counts, pins, castling, en passant, promotion,
checkmate detection, and notation.

## Not included

No clocks, no threefold-repetition or insufficient-material draws (the fifty-move
rule and stalemate are in), and disambiguation in the move notation is by file
only rather than full SAN.
