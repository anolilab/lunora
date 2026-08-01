# Plan 241 — In-app inbox read half (design spike)

**Baseline:** `2d4f71511`
**Status:** SPIKE COMPLETE — memory prototype shipped; D1 backend and the
reactive `useInbox` client hook are design-only, pending the STOP-gated
decision in §5.

## 0. Headline finding

`@lunora/notify` can SEND an in-app notification (`ctx.notify.inApp(payload)`
dispatches through the `inApp` provider) but a user can never READ their
notification center back — there is no persisted inbox, no unread count, no
read receipt. The package says so verbatim at `packages/notify/src/types.ts`
(`NotifyDeliveryStatus`'s doc comment): "The one place a later `seen`/`read`
is real is the in-app inbox, where the client posts a read receipt back — out
of scope here." This spike scopes the READ half: persist, list, unread count,
mark-read.

## 1. Current state (audit)

- `packages/notify/src/providers.ts:82,107-108` — `inApp` is wired into the
  `@visulima/notification` engine as a plain dispatch provider
  (`providers.inapp = resolved.inApp`), same as chat/webhook. It sends and
  forgets; nothing persists the payload.
- `packages/notify/src/notify.ts` — `notify.inApp(payload)` calls
  `sendToChannel("inapp", payload)`, which counts a metric and returns a
  `Receipt`. No store is touched.
- `packages/notify/src/subscriptions/` holds the **device**-subscription
  store (`StoredSubscription`: Web Push endpoint / FCM token, keyed by a
  content-hash id) — this backs push DELIVERY targets, not inbox CONTENT. It
  has no `userId`-scoped content list, no read state.
- `packages/notify/src/queue.ts` (plan 222) established the
  `after`/`limit` keyset-pagination shape (`SubscriptionFilter`) this spike's
  `ListInboxFilter` deliberately reuses the field names of, for a consistent
  package-wide pagination vocabulary — see §4.4 for why the ORDER differs.
- `InAppPayload` (`@visulima/notification`) already carries `to: string`
  ("Subscriber id the notification belongs to"), `title?`, `body`, `data?`,
  `actions?` — i.e. it already IS shaped like an inbox item's content plus a
  recipient. See §2.

## 2. Existing seams (do not reinvent)

- **`SubscriptionStore` pattern** (`packages/notify/src/types.ts`,
  `subscriptions/{memory,d1}-store.ts`): a small persistence interface with a
  memory default + a D1-backed implementation, wired into `defineNotify` via
  an optional `store: (env) => SubscriptionStore` factory, falling back to a
  non-durable memory store with a one-time dev warning when unset. The
  prototype in this spike (`packages/notify/src/inbox/`) mirrors this shape
  exactly (`InboxStore`, `memoryInboxStore()`) so a future `d1InboxStore()`
  slots in the same way — see §4.1.
- **Plan 222's keyset cursor** (`SubscriptionFilter.after`/`limit`): ascending
  by a sortable `id`, exclusive cursor, page-size independent of the "total
  cap" `limit`. `ListInboxFilter` reuses the `{ after, limit }` field names
  for a consistent vocabulary but the ORDER is reversed (newest-first) — see
  §4.4, this is a deliberate divergence, not an oversight.
- **`PushContent = Omit<PushPayload, "to">`** (`packages/notify/src/types.ts`):
  the existing pattern for "the engine payload minus the recipient, because
  the recipient is carried by the surrounding call/record instead." This
  spike's `InboxContent = Omit<InAppPayload, "to">` is the same move applied
  to `InAppPayload` — see §4.1.
- **Lunora's reactive query pipeline** (`ctx.db` tables +
  `useQuery`/`useSubscription`, `@lunora/do`'s per-shard SQLite + OCC +
  hibernated WS subscriptions): the ONLY mechanism in this codebase that
  already delivers "the client sees a new row without polling." Central to
  §5's live-delivery recommendation — do not invent a second live-delivery
  mechanism if this one reaches.

## 3. The behavioural contract to preserve

- `packages/notify/src/types.ts`'s `NotifyDeliveryStatus` doc comment's
  "out of scope here" note for read receipts must be either reconciled (this
  spike does NOT remove it — see §7, it stays accurate: `notify.inApp` itself
  still doesn't touch read state, only a configured `InboxStore` would) or
  updated in the same change that wires the receipt into `notify.inApp`.
  **Not done in this spike** — `send`/`broadcast` are explicitly out of scope
  (SCOPE note in the originating plan).
- `notify.inApp(payload)`'s current behavior (dispatch-only, returns a
  `Receipt`, no persistence) must be UNCHANGED by this spike. Verified: no
  edits to `notify.ts`, `providers.ts`, or `queue.ts`; `packages/notify/__tests__/notify.test.ts`'s
  existing suite passes unmodified (108 tests total across the package, up
  from 96 after plan 222 — the +12 are the new `inbox.test.ts`).

## 4. Design decisions

### 4.1 Store shape

```ts
interface InboxItem {
    id: string; // store-assigned, monotonically sortable
    userId: string; // owning user — always present, never anonymous
    payload: InboxContent; // Omit<InAppPayload, "to"> — title/body/data/actions
    category?: string; // coarse filter tag, e.g. "billing" | "social"
    groupKey?: string; // client-collapsing key, e.g. "comment:42" — NOT interpreted by the store (§4.5)
    createdAt: number; // unix-ms
    readAt?: number; // unix-ms, undefined while unread
}
```

Relation to the device-subscription store: **none at the storage level, only
at the call-site level.** `SubscriptionStore` answers "which physical
devices/browsers does this user have, and how do I push to them" (many rows
per user, content-hash keyed, no notion of "read"). `InboxStore` answers
"what has this user been told, and have they seen it" (one row per
notification, counter-keyed, no notion of a device). A future combined
send helper could write to BOTH stores for one logical notification (push a
device alert AND persist an inbox row), but that is a `send`/`broadcast`
change and is explicitly out of scope here (see the originating plan's
SCOPE note).

Rejected alternative: folding inbox rows into `StoredSubscription` (add
`readAt`/`payload` fields there). Rejected because a subscription is
PER-DEVICE (a user with 3 browsers has 3 subscription rows) while an inbox
item is PER-EVENT PER-USER — conflating them would multiply inbox rows by
device count for no reason, and complicate the subscription store's already
delicate legacy-id-migration logic (`normalize.ts`) with unrelated fields.

### 4.2 Write-coupling: does `ctx.notify.inApp(...)` persist?

**Recommendation: yes, but opt-in — only when an inbox store is
configured**, mirroring `defineNotify`'s existing `store?: (env) =>
SubscriptionStore` pattern:

```ts
export default defineNotify({
    inApp: (env) => someInAppProvider(env),
    inboxStore: (env) => d1InboxStore(env.DB), // NEW, optional
});
```

When `inboxStore` is configured, `notify.inApp(payload)` would ALSO call
`inboxStore.append({ userId: payload.to, payload: rest, category, groupKey })`
after (or alongside) the provider dispatch — `payload.to` already carries the
recipient, so no new parameter is needed at the call site. When unset,
`inApp` keeps today's dispatch-only behavior byte-for-byte (no behavior
change for an app that hasn't opted in).

Rejected alternative: always persist unconditionally. Rejected because (a) it
would force every `@lunora/notify` consumer into owning inbox storage/rows
even if they never show a notification center, and (b) it breaks the
"unconfigured falls back safely" pattern the rest of `defineNotify` follows
(`store` unset → memory + warning, never a silent behavior change on an
unrelated call).
Rejected alternative: a separate explicit `ctx.inbox.append(...)` call site
instead of piggybacking on `notify.inApp`. Rejected because it would require
every call site to remember to call both — the coupling is exactly the kind
of "forget once, it's silently broken" gap this spike exists to close, and
the WHY section's motivating gap ("send but can't read back") is specifically
about `inApp` sends not becoming inbox rows.

### 4.3 Query surface

```ts
listInbox(userId: string, filter?: { after?: string; limit?: number; unreadOnly?: boolean }): Promise<InboxItem[]>
unreadCount(userId: string): Promise<number>
```

Reuses plan 222's `{ after, limit }` field names for a consistent
package-wide pagination vocabulary. `unreadOnly` is new (no push-subscription
equivalent — a device subscription has no "unread").

### 4.4 Why `after` is reversed from plan 222

Plan 222's `SubscriptionFilter.after` pages ASCENDING by id — appropriate for
a `broadcast` walking a whole audience in some order, order doesn't matter to
the sender. An inbox is a notification CENTER: a user expects the newest
item on top, exactly like every inbox/feed UI. So `listInbox` is
**newest-first**, and `after` means "strictly OLDER than this cursor" (a
smaller id in this scheme) rather than "greater than." The prototype's ids
are a monotonically increasing per-store counter (`inbox_000000000042`), so
descending-id order IS descending-chronological order; a real backend would
use an equivalent sortable scheme (ULID, a D1 autoincrement rowid, a
`(createdAt, id)` compound key). This is documented in
`packages/notify/src/inbox/types.ts` on `ListInboxFilter.after` directly, so
a reader hitting one cursor shape after the other doesn't assume they match.

### 4.5 Receipt

```ts
markRead(id: string): Promise<void>       // idempotent — no-op if already read or unknown id
markAllRead(userId: string): Promise<number>  // returns count actually changed
```

No `markUnread` — flagged as an open question (§6.1), not decided here.

### 4.6 Reactive delivery mechanism

This is the load-bearing decision this spike exists to make **a
recommendation, not a build**, on (see the STOP condition in the originating
plan). Three options considered:

**Option A — Lunora-native reactive table (recommended).** `@lunora/notify`
ships a schema-merge helper (an `inboxTable()` fragment an app splices into
its own `defineSchema`, or a `vis generate lunora-inbox` scaffold mirroring
the other generators) plus generated `listInbox`/`unreadCount` queries and a
`markRead` mutation. Reactivity is then **free** — it comes from the exact
same `ctx.db` + per-shard SQLite/OCC + `useQuery`/`useSubscription` pipeline
every other live Lunora read already uses (`packages/do`'s `ShardDO`). No new
live-delivery mechanism to design, build, or maintain.
Cost: this is an architectural expansion of `@lunora/notify`'s footprint — it
currently owns ONLY its own D1 tables outside the app's reactive schema graph
(lazily `CREATE TABLE IF NOT EXISTS`'d by `d1SubscriptionStore`), the same
shape this spike's `d1InboxStore` (not built) would naturally take if it just
mirrored `d1SubscriptionStore`. Option A means the inbox does NOT mirror that
pattern — it becomes the first `@lunora/notify` feature backed by an
app-schema table instead of a package-private one, which is a real
precedent-setting change, not a routine store addition.

**Option B — Poll-based `useInbox`.** No new mechanism: `useInbox()` polls
`listInbox`/`unreadCount` on an interval or on window focus/visibility
change. Works with ANY backend, including a package-private D1 store
(`d1InboxStore` mirroring `d1SubscriptionStore` exactly, zero schema-graph
change). Con: not truly live (visible staleness up to the poll interval),
adds steady request volume proportional to connected clients.

**Option C — Piggyback the existing WS connection with a custom event.** The
client already holds a live per-shard WebSocket for query subscriptions
(`@lunora/do`'s hibernated WS subscriptions, `@lunora/client`). The server
could push an out-of-band `"inbox:new"` message over that socket when
`notify.inApp()` fires for a session known to be connected, and `useInbox()`
listens and refetches/patches locally. Con: needs `@lunora/notify` to reach
into `@lunora/do`'s session/WS registry — a new cross-package coupling
(structurally similar in spirit to the `@lunora/queue` seam from plan 222,
but for OUTBOUND delivery into a live connection rather than a triggered
job) that does not exist today and would need its own design pass.

**Recommendation: Option A for the eventual 1.0-quality inbox** (reuses
proven, already-hardened infrastructure — no new live-delivery mechanism is
ever the safer choice when one already reaches). **Option B as the pragmatic
interim** if Option A's schema-graph footprint expansion is rejected or
deferred — it is strictly less work and compatible with the D1-store
prototype shape already sketched in §4.1/§2. **Option C is not recommended**
unless both A and B are ruled out; it is the most bespoke and highest-risk of
the three.

**This spike stops here, at the recommendation** — no reactive delivery
mechanism is implemented, and the memory prototype in
`packages/notify/src/inbox/` deliberately says nothing about which option a
D1 backend will eventually pick (it is a query/receipt-surface proof, not a
delivery-mechanism proof).

## 5. STOP condition reached

Per the originating plan: **"live inbox delivery requires a mechanism notify
can't reach (it would need to own a Lunora table + subscription) — document
the options and stop at the recommendation, don't force one."** §4.6's Option
A is exactly this case — a live inbox that reuses Lunora's reactive pipeline
requires `@lunora/notify` to either own (part of) the app's schema or
generate code into it, which today it does not do anywhere else in the
package. This is documented above with a recommendation; it is intentionally
NOT implemented in this spike.

## 6. Open questions (answer during execution)

1. **Dispatch-persists vs. explicit opt-in call.** §4.2 recommends
   `inboxStore` config gates automatic persistence on `notify.inApp()`
   (opt-in AT THE `defineNotify` LEVEL, but automatic once configured, not a
   second call site). Confirm this is the desired ergonomics before building
   the D1 store — an app author who wants inbox rows only for SOME `inApp`
   sends (not all) would need an escape hatch this design doesn't yet have.
2. **Live delivery mechanism — Option A vs B vs C (§4.6).** Blocks the
   `useInbox` hook's contract (a thin `useQuery` wrapper under Option A looks
   nothing like a polling hook under Option B). Needs a decision before any
   client-hook work starts.
3. **Retention / cap.** An inbox is unbounded by construction (every send
   appends). Options: (a) TTL-based expiry (cron-swept, needs
   `@lunora/scheduler`), (b) a per-user row cap (evict oldest beyond N on
   append, no cron needed, bounded storage cost), (c) no built-in cap
   (document it as the app's responsibility, maybe an `@lunora/advisor` lint
   for an inbox table past some row-count threshold). Leaning (b) as the
   safer default with (a) as an optional additional layer, but there's no
   usage data yet to size N or a TTL against.
4. **Grouping/collapsing.** `groupKey` exists on `InboxItem` (§4.1) but the
   prototype does not collapse/merge on it — every `append` is a new row even
   with a repeated `groupKey`. Does a real backend upsert-by-`groupKey` (e.g.
   bump a `count` field, refresh `createdAt`) so "3 people liked your post"
   collapses server-side, or does every event get its own row and the CLIENT
   collapses for display (grouping by `groupKey` in the `useInbox` render
   layer)? Leaning client-side collapsing (keeps the store simple, more
   flexible UI, no lossy server merge) but not decided.
5. **`markUnread`?** No use case identified yet (unlike email, an in-app
   notification center rarely needs unmarking) — left out of `InboxStore` on
   purpose; add if a concrete need shows up rather than speculatively.
6. **`useInbox` hook contract.** Sketch, pending Q2's decision:
   `useInbox({ limit? }) => { items, unreadCount, markRead(id), markAllRead(), loadMore(), isLoading }`,
   mirroring the existing `useQuery`/`useMutation` family shapes. Under
   Option A this is close to a thin wrapper generated alongside the
   `listInbox` query; under Option B it needs its own polling/interval
   internals; under Option C it needs a WS-event listener. Not buildable
   until Q2 resolves.
7. **Does a category/`unreadOnly` combination need its own index thinking for
   D1**, or is a straightforward `WHERE user_id = ? AND read_at IS NULL
ORDER BY id DESC` (mirroring `d1SubscriptionStore`'s existing
   `user_id`/`kind` index pattern) sufficient at expected inbox volumes? Not
   answerable without the retention decision (Q3) bounding table size first.

## 7. What shipped in this spike

- `packages/notify/src/inbox/types.ts` — `InboxItem`, `InboxContent`,
  `AppendInboxInput`, `ListInboxFilter`, `InboxStore`.
- `packages/notify/src/inbox/memory-store.ts` — `memoryInboxStore()`, the
  only `InboxStore` implementation so far.
- `packages/notify/__tests__/inbox.test.ts` — 12 tests: append/unreadCount,
  markRead (incl. idempotence and unknown-id), newest-first listing incl.
  paged cursor walk (no skip/duplicate), `unreadOnly` filtering,
  `markAllRead` (incl. the count-changed return and idempotence), per-user
  isolation, payload/category/groupKey round-trip, plain `limit`, and the
  empty-inbox case.
- **Deliberately NOT shipped:** a D1 `InboxStore` implementation, the
  `useInbox` client hook, any change to `notify.inApp`/`send`/`broadcast`,
  and any schema/codegen integration (§4.6 Option A). The prototype is
  intentionally unexported from `packages/notify/src/index.ts` — it is not
  yet a stable public surface; tests import it by relative path, the same way
  the subscription-store tests do for internal-only helpers.
