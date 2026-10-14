# Plan 162 Phase 0 — CLIENT-01 crossTabSync subscribe-relay: design & recommendation

> Companion to `plans/162-crosstabsync-leader-and-queue-ordering.md`. That plan's
> Steps 1–2 (CLIENT-02 leader demotion/health, CLIENT-03 offline-queue hydrate
> ordering) shipped as concrete fixes on `advisor/162-crosstabsync`. This doc is
> the Step 3 (CLIENT-01) design-only deliverable: no relay protocol code ships
> here — this is the artifact the plan asks for so a maintainer can choose a
> direction before anyone builds it.

## The gap (recap, verified against live code at commit `f41f1823`)

`crossTabSync: true` elects one tab (the `TabCoordinator` leader, `cross-tab.ts`)
to own every WebSocket connection for the browser profile; follower tabs mirror
data over `BroadcastChannel` instead of opening sockets. The wire message union
today (`cross-tab.ts:57-64`) is **leader → follower only**:

```ts
type WsFollowerMessage = { type: "heartbeat" | "claim-leadership" | "yield-leadership"; … };
type WsLeaderMessage = { type: "subscription-data" | "subscription-error"; key: string; tabId: string; … };
```

There is no `follower → leader` message at all. On a follower tab, `subscribe()`
(`lunora-client.ts:2850-2916`) does the normal bookkeeping — registers a
`SubscriptionState`, replays a cached value if one exists — then calls:

```ts
this.ensureSocket(options.shardKey); // no-op: returns early when !tabCoordinator.isLeader() (line 3936)
this.sendSubscribeIfOpen(state); // no-op: no connection is ever open on a follower
```

Both are silent no-ops on a follower. The follower's only path to real data is
`onSubscriptionData` (`lunora-client.ts:875-897`), fed by the leader's
`broadcastSubscriptionData(key, payload)` call at `lunora-client.ts:4599-4603`,
which only fires **when the leader's own `handleServerFrame` updates a
`SubscriptionState` it already holds**, keyed by
`SubscriptionRegistry.key(functionPath, args, shardKey)`. If the leader never
independently subscribed to that exact `(functionPath, args, shardKey)` tuple,
no broadcast for that key ever happens — the follower's callback never fires.
**The subscription is stuck loading forever**, silently, with no error surfaced
(the follower has no way to know the leader isn't listening for it).

Separately, `wasEverConnected` (`lunora-client.ts:1758`, gates offline-mutation
queueing at `1755-1764`) is set `true` only at `lunora-client.ts:4045`, inside
the real WS open-handshake path — which a follower never runs (its connections
map stays empty; `ensureSocket` returns before `getOrCreateConnection`). A
follower's `mutate()` while offline therefore fails fast instead of queueing,
because the client believes it has never successfully connected — even though
the _leader_ tab is fully connected and the mutation could safely queue and
flush once the leader relays it.

## An additional risk found while researching this: identity is not part of the relay key

`broadcastSubscriptionData`'s key is `(functionPath, args, shardKey)` — it does
**not** include the subscriber's identity. Each `LunoraClient` instance (i.e.
each tab) has its own `identityFingerprint()` (`lunora-client.ts:4792-4811`,
derived from that instance's own `authSubject`/`authToken`, set via
`setAuthToken`). Nothing today stops two tabs of the same origin from being
signed in as **different** identities — `@lunora/auth`'s `multi-session` plugin
is an explicit, shipped feature for exactly that. If tab A (leader, user X) and
tab B (follower, user Y) both call `subscribe(api.me.profile, {})`, they
compute the **same** registry key, so today's `broadcastSubscriptionData` would
hand user X's profile data to a tab authenticated as user Y — a same-origin,
same-key cross-identity data leak. This is not unique to the CLIENT-01 relay;
it already exists in the shipped leader→follower broadcast path, but any
relay design must not make it worse (see Recommendation §4).

## Proposed protocol (subscribe-relay), for evaluation only

If a maintainer decides to build the relay, this is the shape it should take:

### 1. New wire messages (extend, don't replace, the existing union)

```ts
// follower → leader
type WsRelayRequest =
    | { type: "subscribe-request"; tabId: string; key: string; functionPath: string; args: Record<string, unknown>; shardKey?: string; identity: string | null }
    | { type: "unsubscribe-request"; tabId: string; key: string };

// leader → follower (new; alongside the existing subscription-data/-error)
type WsRelayResponse =
    | { type: "subscription-ack"; key: string; tabId: string } // leader now holds this key
    | { type: "subscription-unavailable"; key: string; tabId: string; reason: string }; // e.g. identity mismatch, leader has no socket
```

`identity` rides on the request so the leader can refuse to relay across a
mismatched identity (see §4) instead of silently serving the wrong tab's data.

### 2. Leader-side refcounting

The leader needs a **remote-interest table**, separate from its own
`SubscriptionRegistry`: `Map<key, { localHolders: boolean; remoteTabIds: Set<string> }>`.

- On `subscribe-request`: if `identity` doesn't match the leader's own
  connection identity for that key's shard, reply `subscription-unavailable`
  (reason `"identity-mismatch"`) rather than silently hanging. Otherwise, add
  `tabId` to `remoteTabIds`; if this is the _first_ remote (or local) holder for
  the key, open/ensure the real subscription (`this.subscribe(...)`-equivalent
  server-side registration) exactly as it does today for its own callers; if a
  value is already cached (the leader already held it), immediately unicast
  (not broadcast) the last value + an ack to the requesting tab so a late
  joiner doesn't wait for the next server frame.
- On `unsubscribe-request` (fired from the follower's returned `Unsubscribe`
  when its local `callbacks` set empties): remove `tabId` from `remoteTabIds`;
  when both `localHolders` is false and `remoteTabIds` is empty, tear down the
  server-side subscription (mirrors today's `subscribe()` unsubscribe path at
  `lunora-client.ts:2931-2940`), so a relay doesn't pin dead subscriptions on
  the leader forever.
- Leader handoff: a promoted tab has none of this remote-interest state. Either
  (a) followers re-issue `subscribe-request` for everything they hold whenever
  they observe a new leader (cheap, self-healing, some redundant server
  round-trips), or (b) the outgoing leader's `onStopBeingLeader` broadcasts its
  remote-interest table so the new leader can seed it — (a) is simpler and
  safer against a leader that dies with no graceful handoff (crash, closed tab);
  recommend (a).

### 3. Follower-side change

In `subscribe()`, when `this.tabCoordinator` exists and is **not** the leader,
send `subscribe-request` instead of (today's no-op) `ensureSocket` +
`sendSubscribeIfOpen`. On `subscription-ack`, mark the local state as
optimistically "connected" (see `wasEverConnected` below). On
`subscription-unavailable`, surface it through the subscription's
`errorCallbacks` (today's silent-hang becomes a visible, catchable error
instead) rather than leaving the caller's `useQuery` spinning forever.

### 4. `wasEverConnected` on followers

Recommend: a follower should treat **"the leader is connected"** as its own
connectivity signal for the offline-queue gate, not "I personally opened a
socket." Concretely: the leader broadcasts its own connection-status changes
(a small addition — `WsLeaderMessage` gains a `connection-status` variant
mirroring `emitConnectionStatus()`), and a follower's `wasEverConnected`-gated
check (`lunora-client.ts:1758-1764`) becomes `wasEverConnected || (tabCoordinator
&& lastKnownLeaderConnectionStatus === "connected")`. This is a narrow,
low-risk addition on top of the existing broadcast mechanism (no new
follower→leader message needed for this part) and directly fixes "offline
mutations fail fast on a follower."

## Open questions a maintainer must settle before anyone builds this

1. **Identity scoping**: should `subscribe-request` refuse a cross-identity
   relay outright (fail closed, as sketched above), or should the leader
   maintain **per-identity** sub-registries so two differently-authenticated
   tabs can each get correctly-scoped data through one leader? The latter is
   materially more work (the leader would need to open a _second_ class of
   server subscription under the follower's identity/token, which the leader's
   own WS connection can't represent — it has exactly one authenticated
   session per shard today). This alone could be a reason to scope `crossTabSync`
   to "same-identity tabs only" for v1 and document the restriction.
2. **Wire/version skew across mixed app deployments**: a `BroadcastChannel` is
   shared by _any_ tab of the origin regardless of which deployed app version
   it loaded (a live rollout can have old-code and new-code tabs open
   simultaneously). Old-code tabs won't send/understand `subscribe-request` —
   an old-code leader with new-code followers reproduces today's silent-hang
   bug; a new-code leader with old-code followers is unaffected (old followers
   just don't use the new path). Does this need a protocol version handshake
   (e.g. a version field on `claim-leadership`/`heartbeat`) so a follower can
   detect "my leader can't relay" and fall back to opening its own socket
   (defeating the connection-sharing goal, but at least not hanging)?
3. **Shape subscriptions parity**: `subscribeShape` (`lunora-client.ts:2956+`)
   has the identical gap (no relay) and isn't covered by the sketch above; it
   would need its own `shape-subscribe-request`/`-ack` pair with the same
   identity question, likely a bigger lift (membership diffs, not a single
   cached value to unicast to a late joiner).
4. **Backpressure / fan-out cost**: today the leader broadcasts one message per
   _distinct key it holds_, once, to all followers indiscriminately. A relay
   makes the leader responsible for potentially many followers' distinct keys
   (the union of everyone's subscriptions) — does the leader need its own
   subscription cap / rate-limit so one chatty follower tab can't force the
   leader to hold hundreds of extra server-side subscriptions?
5. **Ordering/at-least-once for `subscribe-request`/`unsubscribe-request`**:
   `BroadcastChannel` delivery has no acknowledgement or retry built in (unlike
   the WS frame protocol, which already handles reconnect/resume). If a
   follower's `subscribe-request` is sent while the leader is mid-handoff (see
   Leader Election, plan Step 1) or the message is simply lost, does the
   follower need its own retry/timeout, and if so what timeout — coupled to
   `leaderTimeout`, or independent?

## Recommendation

**Gate `crossTabSync` as experimental (documented limitation) rather than
building the relay now.** Reasoning:

- The relay itself is a genuine wire-protocol design (new message types, a
  leader-side refcounted registry, a version-skew story) — exactly the class
  of change plan 162 was told to design-first rather than build blind, per its
  STOP condition ("Implementing CLIENT-01's relay turns out to require a
  wire/protocol version bump across mixed app versions — that's exactly why
  it's design-first").
- The identity-scoping question (§Open questions #1) is not a detail to settle
  in review — it changes the shape of the leader-side registry (single vs.
  per-identity), and the current broadcast path _already_ has the same
  cross-identity gap unaddressed, so it deserves a decision on its own rather
  than being inherited by a bigger relay.
- Until this lands, the existing behavior — a follower subscription silently
  never resolving if the leader doesn't independently hold it — is a
  footgun users hit silently. Ship two changes now, cheaply, ahead of a
  full relay:
    1. **Document** the limitation explicitly wherever `crossTabSync` is
       described (options JSDoc + any user-facing docs): "follower tabs only
       mirror subscriptions the leader tab also holds; a follower-only
       subscription will not resolve." (Already noted as a maintenance follow-up
       in plan 162.)
    2. **Fail loud instead of silent**: even without the relay, a follower could
       detect "I've been waiting N seconds with no `subscription-data` for this
       key and I'm not the leader" and surface a warning/error through
       `errorCallbacks` — cheap, no wire changes, converts a silent hang into a
       debuggable signal. Worth doing regardless of the relay decision.
- If/when a maintainer wants the full relay, the protocol sketch above
  (§Proposed protocol) is the starting point — but identity-scoping (#1) and
  version-skew (#2) should be explicitly ruled on before implementation
  starts, not discovered mid-build.

## STOP compliance

No relay protocol code was written for this plan. This document, plus the
`plans/README.md` status update, are the only Step-3 deliverables.
