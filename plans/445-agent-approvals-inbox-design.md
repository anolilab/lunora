# Plan 445 design: The pending-approvals inbox for the HITL surface

> Deliverable of plans/445-agent-approvals-inbox-spike.md. Design only — no
> `src/` change ships from this document. Drift check at `207be1b63` (HEAD):
> zero drift in `component.ts`, `model-messages.ts`, `agent-tools.ts`.
> Plan 436 has **not landed on this checkout** (it is being implemented
> concurrently on `improve/wave22-agent`); this design targets 436's specified
> end-state — a timed-out approval patches the marker row *in place* to
> `status: "rejected"` (same `messageKey`, per its Step 2), and
> `awaiting_input` threads leave the abandoned reclaim (its Step 1, shape 1
> preferred). Where 436's two candidate shapes diverge, both are handled
> (see Interactions).

## 1. Inventory (the read path as it exists)

Line numbers at HEAD `207be1b63`, `packages/agent/src/component.ts`
(957 lines).

**Threads table** (`:90-146`): columns `agent`, `createdAt`, `error?`,
`instanceId?`, `key`, `messageCount`, `owner?`, `state?`,
`status` (`idle | running | error | cancelled | awaiting_input`), `title?`,
`updatedAt`, `usage?`. Indexes (`:137-141`):

| Index | Columns | Unique |
|---|---|---|
| `byKey` | `["key"]` | yes |
| `byAgent` | `["agent"]` | no |
| `byInstance` | `["instanceId"]` | no |

**There is no index on `status` and none on `owner`.** "All of an owner's
threads with `status = 'awaiting_input'`" cannot be served by an existing
index — it is either a full-table scan with a JS filter or a new index
(decision below).

**Messages table** (`:64-89`): columns include `content`, `createdAt`,
`messageKey`, `role`, `seq`,
`status?` (`awaiting_approval | approved | rejected`, `:77`), `threadKey`,
`toolCallId?`, `toolName?`. Indexes (`:85-87`):

| Index | Columns | Unique |
|---|---|---|
| `byThread` | `["threadKey", "seq"]` | no |
| `byMessageKey` | `["threadKey", "messageKey"]` | yes |

`agentMessages` reads `byThread` (`:724`, `:735`), descending + `.take(limit)`
for the bounded tail, ascending `.collect()` unbounded. There is **no status
index on messages** either; joining a thread to its `awaiting_approval` rows
is a `byThread` scan filtered on `status` (bounded by that thread's
`messageCount`).

**The marker row** (`packages/agent/src/agent-loop.ts:216-223`):
`messageKey: ${instanceId}:approval:${call.id}`, `role: "tool"`,
`status: "awaiting_approval"`, plus `toolCallId` and `toolName`. On
resolution the same row is patched to `approved`/`rejected` (messages-table
doc, `component.ts:72-77`), and `model-messages.ts:68-74` skips
`awaiting_approval` rows when building the model prompt — they are pure
UI/observability markers, which is exactly what an inbox wants.

**Schema sufficiency (STOP-condition check)**: every column the inbox needs
exists — the resolve triple (`threadKey` = thread `key`, `instanceId`,
`toolCallId`), display fields (`toolName`, `content`, thread `agent`,
`title`, `createdAt`/`updatedAt`), and the gate field (`owner`). Only
*indexes* are missing, and the pending-thread population is small (bounded by
concurrently-paused runs), so no migration is required to ship — the index is
an optimization decision, not a blocker. No STOP.

## 2. Proposed API

### `agentPendingApprovals` (public query, owner-gated)

```ts
const agentPendingApprovals = query
    .input({ limit: v.optional(v.number()) })
    .query(async ({ args, ctx }): Promise<PendingApproval[]> => { ... });

interface PendingApproval {
    // The resolve triple — exactly what agentResolveApproval requires
    // (component.ts:760-766):
    threadKey: string;
    instanceId: string;
    toolCallId: string;
    // Display fields:
    agent: string;          // thread.agent
    content: string;        // the marker row's content
    threadTitle?: string;   // thread.title
    toolName?: string;      // marker row
    requestedAt: number;    // marker row createdAt
    threadUpdatedAt: number;
}
```

**Algorithm** (two bounded reads, no join machinery):

1. `threads` where `status === "awaiting_input"`, filtered to
   `owner === ctx.auth.userId` (see Gating), ordered by `updatedAt`
   descending, capped at `args.limit ?? 50` threads. Without a new index this
   is a table scan with a filter; with the recommended
   `.index("byStatus", ["status", "updatedAt"])` it is an index read in final
   order. Recommendation: **ship with the index** — it is one line in the
   extension's `defineTable` (`:137-141`), the table is package-owned (no app
   migration story beyond the extension's own), and it also serves any future
   operator view. If the reviewer prefers zero schema movement, the scan
   variant is correct today and the index becomes a follow-up; the ceiling is
   O(total threads) per subscription re-run.
2. Per matched thread (≤ limit of them): scan `byThread` for rows with
   `status === "awaiting_approval"` **and**
   `messageKey.startsWith(\`${thread.instanceId}:approval:\`)`. The prefix
   check is load-bearing, not cosmetic: a marker minted by a *previous*
   instance (pre-436 stranded approvals, or a `replace`d run) is unresolvable
   by construction — `agentResolveApproval` rejects any `instanceId` that is
   not the thread's current one (`:780-784`) — so surfacing it would hand the
   client a triple that can only ever throw `FORBIDDEN`. Emit one
   `PendingApproval` per surviving row. Per-thread cost is O(`messageCount`);
   acceptable because step 1 bounds the thread count and paused threads are
   few. (A `byThreadStatus` messages index is deliberately *not* proposed —
   premature for this population size.)

**Pagination**: `limit` only, newest-first by thread `updatedAt` — exactly
`agentMessages`'s convention (`:702`, `limit` + no cursor). An approvals
inbox beyond one page of *pending* items is an operational fire, not a
pagination problem; no cursor until a real consumer needs one.

**Ordering**: thread `updatedAt` desc, then marker `seq` asc within a thread
(stable, matches how the run emitted them).

**Registration**: added to the returned `functions` map
(`component.ts:934-951`) as a public query (not `asInternal`). Two mandatory
same-change companions, both documented in-repo:

- codegen's `syntheticAgentApiFunctions` mirror
  (`packages/codegen/src/emit.ts:1060`, `:1266`) — the KEEP IN SYNC comment
  at `component.ts:667-672` requires the emitted `api.agents.*` reference
  types to be updated by hand when a public query is added; the arg-key drift
  test covers the rest.
- `packages/mcp/src/agent-tools.ts:22-32`'s hardcoded path constants only if
  the MCP tool ships (Interactions).

**Client surface**: nothing new needed structurally — the query rides the
existing reactive transport like `agentMessages`; a `useAgentApprovals()`
hook in `@lunora/react` is a thin `useQuery` wrapper and can trail the
component change.

**Test surface for the build plan**: model on the existing
`component.test.ts` owner-gate tests for `agentThread`/`agentMessages`
(unknown vs. forbidden indistinguishable) and the resolve-approval
instance-mismatch tests; add: (a) owner A never sees owner B's pending
approvals, (b) anonymous caller sees nothing, (c) a marker from a stale
instance is excluded, (d) a resolved (`approved`/`rejected`) marker is
excluded, (e) the returned triple round-trips into a successful
`agentResolveApproval` on the same fixture.

## 3. Gating analysis

`readableThread` (`component.ts:654-665`) has two clauses: an owned thread
answers only its owner; an **ownerless** thread answers *anyone who knows its
key*, and unknown/forbidden are indistinguishable so key-guessing leaks
nothing — not even existence.

A cross-thread listing cannot reproduce the second clause: the whole point of
an inbox is enumerating threads the caller did *not* name, so "readable by
anyone who knows the key" would become "enumerable by anyone at all" — any
caller could list every anonymous tenant's paused threads, keys included.
That is the cross-tenant leak the spike's risk note warns about.

**The gate, therefore, is deliberately narrower than `readableThread`:**

- `ctx.auth.userId` must be present; an anonymous caller gets `[]` (not an
  error — matching the reads' "empty, never a probe signal" posture,
  `:710-713`).
- Only threads with `owner === ctx.auth.userId` are listed. Ownerless
  threads are **excluded even for authenticated callers** — including them
  would let any signed-in user enumerate threads whose only protection is key
  secrecy. Per-key access to ownerless threads keeps working through
  `agentThread`/`agentResolveApproval` exactly as today; the inbox simply
  never volunteers them.
- Existence leakage across owners: the owner filter is applied *before* any
  row leaves the query and before the `limit` cap, so result counts and
  page boundaries carry no signal about other owners' threads.

**Operator/all-owners scope**: not built. The agent tables are `.public()`
with access control in the functions (`:142-148`), so Studio's existing admin
table reads (`readTablePage` over the reserved `__lunora_admin__` surface)
already give an operator a raw cross-owner view of `threads` filtered by
status — behind the admin bearer, which is the repo's one existing
operator-gate pattern. A dedicated operator inbox verb would duplicate that
gate for a nicer shape; defer until Studio actually designs an approvals
panel (open question 4).

## 4. Interactions

**Plan 436's timeout.** The inbox needs **no timeout-specific filter**: 436's
Step 2 patches the marker row in place (same `messageKey`) to
`status: "rejected"` with content "Approval timed out.", so a timed-out
approval leaves the `status === "awaiting_approval"` predicate automatically
— the filter in section 2 already excludes it. Same for its Step 1 either
way: shape 1 (exclude `awaiting_input` from reclaim) keeps the thread
`awaiting_input` until the timeout resolves it (the inbox correctly shows it
as pending the whole time); shape 2 (a longer reclaim horizon) means a
14-day-stale paused thread can still be reclaimed — the moment the reclaim
re-stamps `instanceId`, the stale-instance prefix check in section 2 drops
its markers from the inbox, which is exactly right (they are no longer
resolvable). The design is safe under both candidate semantics; no flag
needed.

**MCP.** The agent surface's gate is `agentToolDefinitions(exposures,
allowAgents)` returning `[]` unless `allowAgents === true` **and** at least
one exposure is configured (`packages/mcp/src/agent-tools.ts:118-122`),
driven by `LUNORA_MCP_ALLOW_AGENTS` + `LUNORA_MCP_AGENTS`
(`packages/mcp/src/index.ts:18`, `parseAgentsEnv` at `agent-tools.ts:79`) —
config-gated, fail-closed. Proposal:

- **`lunora_agent_approvals` (list): yes.** Advertised under the same
  existing gate, beside `lunora_agent_status` (`:34-35`), dispatching
  `agents:agentPendingApprovals` as a new hardcoded path constant (the
  `:22-29` KEEP IN SYNC block). Value: a gated tool call over MCP currently
  dead-ends — the calling model can now report "run X is blocked waiting for
  a human to approve `toolName`" instead of polling status forever.
- **Approval *resolution* over MCP: no.** HITL approval exists to put a
  human between an agent and a gated tool; exposing
  `agentResolveApproval` to the MCP caller — which is itself a model — lets
  an agent approve agent tool calls, collapsing the control entirely. No
  config flag makes that safe enough to ship by default; if a genuinely
  human-driven MCP client ever needs it, that is its own plan with its own
  gate. (The list tool leaks no new capability: the resolve triple it
  returns is only accepted from a caller who also passes the component-side
  owner/instance gates, `component.ts:773-784`.)

**`@lunora/notify` alternative.** A push notification on marker-write
("your agent needs approval") is the better *first alert*, but it cannot
replace the pull query: a notification is fire-and-forget — lost, dismissed,
or delivered to a device that never opens the app — and recovering from a
missed one requires exactly the enumeration this query provides; push also
needs `@lunora/agent` to grow a `@lunora/notify` dependency (or an app-level
`onApprovalRequired` hook) and solves discovery for one delivery channel
only. Recommendation: pull query first (it is the source of truth an app can
poll, subscribe to, or badge from); a notify hook is an optional app-level
follow-up that reuses the same read model, not part of this build.

## 5. Open questions (each with a recommended answer)

1. **Should the threads table get `.index("byStatus", ["status",
   "updatedAt"])` in the same change?** Recommended: yes — one line in the
   package-owned extension, turns the inbox's hot read into an ordered index
   scan, and is the only part of this design that gets harder to retrofit
   after threads tables grow. If deferred, ship the scan and file the index
   as a follow-up keyed to thread-count telemetry.
2. **Do ownerless (anonymous/single-tenant) apps get an inbox?** Recommended:
   not from the packaged query (gating analysis: enumeration breaks
   key-secrecy). A single-tenant app that wants one writes a three-line app
   query over the public tables where *it* owns the tenancy decision; the
   packaged surface stays safe by default.
3. **Does `lunora_agent_approvals` (MCP list) ship in the first build?**
   Recommended: yes but as the last, separable commit — it is ~40 lines
   following `lunora_agent_status`'s existing shape and rides an existing
   gate; dropping it doesn't change the component design.
4. **Operator (cross-owner) scope?** Recommended: defer. Studio's admin
   table reads already expose the raw data behind the admin bearer; build a
   dedicated verb only when a Studio approvals panel is actually designed,
   and model its gate on the reserved `__lunora_admin__` surface, never on a
   widened public query.
5. **Should the inbox also return `awaiting_input` threads that have *no*
   live marker row (defensive, e.g. a marker write that failed)?**
   Recommended: no — a thread row without a resolvable marker yields no
   usable triple; surfacing it invites "approve" buttons that cannot work.
   Observability for that inconsistency belongs in advisor/telemetry, not in
   the client inbox.

## 6. Build-effort estimate

| Piece | Effort | Notes |
|---|---|---|
| `agentPendingApprovals` query + (optional) `byStatus` index | **S-M** | ~60 lines in `component.ts` incl. docs; the gating tests (section 2 list) are most of the work |
| codegen synthetic mirror | **S** | `emit.ts:1060` block + arg-key drift test entry; mechanical but mandatory (`component.ts:667-672`) |
| Client hook (`useAgentApprovals` in `@lunora/react`) | **S** | thin `useQuery` wrapper; can trail |
| MCP `lunora_agent_approvals` list tool | **S** | mirrors `lunora_agent_status`; new path constant in the `:22-29` block; no new gate |
| MCP resolution tool | **not built** | see Interactions — rejected on HITL-integrity grounds |

Total: one M-sized PR on `improve/wave22-agent`, sequenced after plan 436
lands (the inbox's tests want 436's timeout marker semantics in the fixture
harness, and both touch `component.ts`).
