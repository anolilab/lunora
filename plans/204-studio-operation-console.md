# Plan 204 — Studio operation console

- **Category**: dx/obs (competitive parity — Prisma Studio `console` view)
- **Priority**: P3
- **Effort**: S–M · **Risk**: LOW
- **Status**: DONE (Phases 1–3 shipped)
- **Baseline**: `865a9a4c` (2026-07-28)
- **Goal**: a tape of what **Studio itself** just did — every admin RPC it issued,
  with timing, outcome, and a copyable reproduction — so a failed action in the UI
  is debuggable without opening devtools.

## Context (verified)

**Three log surfaces exist; none answers this question.**

| Surface                                         | Shows                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `features/logs/logs-panel.tsx` (`getLogs`)      | the application's durable logs                                        |
| `features/logs/audit-panel.tsx` (`getAuditLog`) | the server's audit of admin _writes_ (`packages/do/src/audit-log.ts`) |
| `features/reports/…` (`getRequestLog`)          | request-level traffic                                                 |

The server-side audit log is the closest, and it is deliberately a different
thing: it is the **server's** durable record of privileged writes, scoped to what
the server chose to record. It does not carry the client's view — which RPC the
UI called, with which shard and arguments, how long the round trip took, whether
it failed before reaching the server, and in what order relative to the other
calls the same click fanned out.

**What Prisma does** (`Architecture/operation-events.md`,
`ui/studio/views/console/`): every operation Studio issues emits a typed event
through an `onEvent` pipeline into bounded storage, rendered in a Console view
with an explicit ordering contract and per-entry detail (`OperationEventEntry`).

**We have exactly one choke point to hang this on.** Every admin call in Studio
goes through `packages/studio/src/lib/internal.ts` (`adminRef`, `callOptions`,
`errorMessage`, `fireAndForget`) and `hooks/use-admin-query.ts`. Instrumenting
those two covers the surface; there is no second path to miss.

## Design

**Client-side, in-memory, bounded.** A ring buffer (a few hundred entries) in a
Studio context. Not persisted, not sent anywhere — it is a debugging tape for the
current session, and persisting it would create a new place for sensitive data
to accumulate.

**Record shapes, never payloads.** An entry carries: sequence number, timestamp,
function path, shard key, a _summary_ of arguments (table name, filter count,
limit — never row values), duration, outcome (`ok` / `error` + message), and
result size (row count / byte estimate). Row data never enters the buffer. This
follows the same reasoning already recorded for the Studio admin token: Studio is
a local operator UI, and the deliberate tradeoffs it makes should stay narrow.

**Complement, not replacement.** The console answers "what did this UI do"; the
audit panel answers "what did the server record". Both stay, and the console
links out to the audit panel for a write it issued.

## Phase 1 — Event emission

- [x] `OperationEvent` type + a bounded `OperationLog` ring buffer in a Studio
      context provider.
- [x] Instrument the single choke point: `lib/internal.ts` +
      `hooks/use-admin-query.ts` emit an event per call — one on dispatch (with a
      monotonic sequence number assigned at dispatch, so ordering reflects issue
      order, not completion order) and one on settle.
- [x] Argument summarisation is per-function and explicit — a small map from
      function path to a summariser. Default for an unmapped function: record the
      argument _keys_ only. Never a blanket `JSON.stringify(args)`; that is how
      row values leak in.
- [x] Live subscriptions record one entry per CHANNEL: `startSubscription` on
      open, `recordPush` bumping a counter per push, `failSubscription` on channel
      error, `endSubscription` on teardown — which does NOT overwrite an error
      status, because the teardown of something already reported broken must not
      erase the diagnosis. A `subscription` entry is badged `live` and shows its
      push count, so a channel sitting at `live` reads as healthy while a `call`
      stuck at `pending` reads as hung.

## Phase 2 — The view

- [x] A dockable console drawer (keyboard-toggled, reachable from the command
      palette in `app/command-palette.tsx`), not a top-level nav page — it is a
      companion to whatever page you are on.
- [x] Row per operation: relative time, function, shard, duration, outcome badge.
      Expand for the argument summary and the error, if any.
- [x] Filter by outcome (errors only), by function, by shard. Free-text match.
- [x] "Copy as call" — the function path + argument summary in a form that can be
      pasted into the SQL console or an issue report.
- [x] An error entry links to the corresponding audit-log row when the operation
      was a write that the server recorded.

## Phase 3 — Wire it to failures

- [x] The drawer's open/focus state moved into `components/operation-console-provider.tsx`,
      wrapped around the shell (`StudioLayout` → provider → `StudioLayoutShell`,
      split because a component cannot read a context it provides itself). The
      provider's default value is INERT rather than throwing: `ErrorAlert` is
      mounted standalone by other suites, and a debugging affordance must never be
      the reason an error component crashes.
- [x] `recordedCall` tags a rejection with its tape sequence under a Symbol key
      (invisible to `JSON.stringify` and to the existing `errorMessage`/`errorHint`
      readers), so `ErrorAlert` opens the console **on the exact entry that
      failed** rather than making the operator hunt for it.
- [x] `LiveError` gets the same affordance. It receives only a message, not the
      error object, so it opens the errors-only view — where the failed
      subscription is the most recent entry — instead of a precise anchor.
- [x] The focused row scrolls into view via a ref callback memoized on `focused`
      (not an effect): it re-attaches exactly when focus flips, so the scroll fires
      when the row mounts into an opening drawer and when focus moves, but never on
      an unrelated re-render where it would fight the operator's own scrolling.

## Exit criteria

- Clicking through a table load, a filter, and a row edit produces a readable,
  correctly ordered trace of the RPCs each fanned out.
- A failed write shows its error in the console with the shard and argument
  summary that produced it.
- A test asserts no row values reach the buffer for the data-browser read path
  (the summariser map is exercised, not bypassed).
- A component test drives a real failing call through `recordedCall`, clicks
  "show in console", and asserts the drawer opens on that entry, filtered to
  errors — plus that a provider-less `ErrorAlert` stays inert.
- The buffer is bounded: a synthetic 10k-operation burst evicts oldest and does
  not grow memory without limit.
- Zero events emitted when the drawer has never been opened is **not** a goal —
  recording is always on (a tape you have to arm before the bug is a tape that
  misses the bug); the cost is one small object per RPC.

## Non-goals

- Persisting the console across reloads or exporting it automatically.
- Replacing or duplicating the server audit log.
- Recording anything about the user's application traffic — this is Studio's own
  operations only. Application traffic already has `getRequestLog` and the traces
  panel.
