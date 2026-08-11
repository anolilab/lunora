# Plan 333 — Snapshot coherence for query subscriptions

- **Category**: correctness (user-visible torn reads)
- **Status**: DESIGN — a client-only prototype was built, measured, and reverted; the real fix needs a server-side batch boundary
- **Related**: plan 168 (cross-shard transactions), `concepts/realtime`, `non-goals.mdx`

## The gap

Convex guarantees that every query subscription on a client reflects **one
consistent snapshot at a single logical timestamp**, and that they advance
together. Lunora does not: each `data`/`delta` frame notifies its own
subscribers the moment it arrives.

One mutation routinely moves more than one query — a message insert advances the
thread list AND the unread count. The shard re-runs both and writes both frames
in one pass, but the client applies them independently, so a UI reading both can
paint the new list beside the old count. Each value is individually correct;
together they describe a state the database was never in.

This is the half of plan 168 that is **not** about cross-shard writes. It bites a
single-shard app with no `.shardBy()` at all.

## What was tried, and why it was reverted

A client-side coherence window: buffer server-frame updates and flush them on the
next microtask so everything from one batch lands in one commit. Optimistic
updates deliberately stayed synchronous (deferring a local write is the exact
latency optimism exists to hide).

It worked, and it was reverted, for two reasons:

1. **It changes the delivery contract of every subscription in the framework.**
   21 client tests failed immediately — all of them asserting a value
   synchronously after simulating a frame. Those are not bad tests; they encode
   the contract that a frame's value is readable as soon as the frame is handled.
   Every adapter (`react`, `vue`, `svelte`, `solid`, `angular`) and `@lunora/db`
   sit on that contract too.
2. **It buys little that React does not already give.** The frames it coalesces
   are the ones arriving in the same tick, which React 18's auto-batching already
   folds into one render. The tearing that actually reaches users is frames
   arriving in _different_ ticks, which a microtask window cannot merge.

## What the real fix looks like

Query subscriptions need what shapes already have: an explicit batch boundary on
the wire. The poke protocol brackets a batch of shape diffs with
`pokeStart`/`pokeEnd` and the client applies the whole batch atomically
(`protocol/README.md` §5.3). Queries have no equivalent — they carry a `cursor`
but nothing says "these three frames are one commit".

Sketch:

1. **Server.** `flushChangedTables` already re-runs every affected subscription
   for one write in a single pass. Bracket that pass: emit
   `{ type: "batchStart", cursor }` before the frames and `{ type: "batchEnd", cursor }`
   after, on each socket that receives at least one frame.
2. **Client.** Buffer frames between `batchStart` and `batchEnd`, then apply them
   in one commit. Frames outside a batch keep today's synchronous path, so the
   contract only changes where a batch is genuinely in flight — which is what
   keeps the existing tests (and adapters) honest.
3. **Boundary.** The guarantee is per-shard, because that is where the atomic
   commit is. A subscription set spanning two shards or D1 still advances in two
   commits; `non-goals.mdx` already documents that boundary and should say so for
   reads too, not just writes.

## Open questions

1. **Backpressure.** A slow client that never drains a batch must not let the DO
   buffer indefinitely. The shape poke path already faced this — reuse its answer
   rather than inventing a second one.
2. **Partial batches.** A socket that disconnects mid-batch must not apply half
   of it; the client should drop an unterminated buffer on reconnect and re-seed
   from the resume cursor.
3. **Is `cursor` sufficient as the batch identity**, or does a batch need its own
   id the way a poke does? A single write is one cursor, but a coalesced refresh
   (`flushChangedTables` merges pending tables) may span several.
