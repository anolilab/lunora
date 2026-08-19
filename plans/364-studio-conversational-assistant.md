# Plan 364 — A conversational assistant for the Studio, off the DO admin dispatch

**Baseline:** `3a2e83d89` (2026-08-19)
**Status:** W1–W4 SHIPPED; W5 BLOCKED — see §8b. The conversational assistant works end to end; only token streaming is outstanding, and it needs a transport that does not exist yet.
**Spun out of:** [363](363-studio-data-surface-parity.md) W5, which required this
plan before any code.

## 0. Headline finding

**The transport question 363 left open is already answered in the codebase, and
the answer is neither of the two options that plan named.** 363 §9 Q4 asked
"`@lunora/agent` over Workflows, or a plain action with client-held history?" —
but `packages/runtime/src/auth-audit-rpc.ts` shows a third, much smaller shape
that has shipped twice: an `__lunora_admin__:*` op **intercepted and served at
the Worker** instead of forwarded to a shard, admin-gated first, with its
capability injected as a closure dep so the runtime keeps no hard dependency on
the package that provides it.

That matters because the STOP condition in 363 §8 is about where the model runs,
not about durability. `packages/do/src/sql-assistant.ts:70-78` puts a 15 s
deadline on one inference precisely because `binding.run` is awaited on a
single-threaded DO's admin dispatch; a conversation cannot be given one. A
Worker-served op never touches that dispatch, so the STOP condition is satisfied
by choosing where the op is intercepted — not by adopting Workflows.

**Consequence for sizing.** 363 rated W5 an L and called it "the one genuinely
new mechanism". With the transport settled it is closer to an M: the inference
engine, the untrusted fence, the retry policy, the degrade-don't-throw contract
and the admin gate all already exist and are all reusable at the Worker. What is
genuinely new is multi-turn state and tool dispatch, and §4 argues both should
start smaller than "an agent".

## 1. Current state (audit)

- **The assistant is three stateless one-shot RPCs.**
  `packages/studio/src/features/sql/hooks/use-sql-assistant.ts:20-22` —
  `aiGenerateSql` (+ a repair arm), `aiTableFilter`, `aiChartConfig`. Each is a
  single request/response with no history and no follow-up.
- **All three run inside the DO.**
  `packages/do/src/shard-do.ts:6728-6734` registers them on the admin dispatch
  table; `:6703` is the `aiGenerateSql` handler. The engine is
  `packages/do/src/sql-assistant.ts`, which its own docblock describes as "three
  RPCs, but ONE inference primitive (`runPrompt`) and ONE retry policy".
- **A 15 s deadline is load-bearing, and it is about the DO, not the model.**
  `sql-assistant.ts:70-78`: "`binding.run` is awaited on a single-threaded DO's
  admin dispatch, so a hung model would hold that dispatch open indefinitely".
- **Two admin ops are already served at the Worker.**
  `packages/runtime/src/auth-audit-rpc.ts:75-79` (`getAuthAuditLog`) and
  `packages/runtime/src/create-worker.ts:1596` (`listPushSubscriptions`). Both
  share the `__lunora_admin__:` prefix and its gating, and both are intercepted
  before shard forwarding because their data does not live in DO SQLite.
- **`batch.ts:38` already excludes the prefix from batching**, so a long-running
  admin op cannot be coalesced with unrelated calls.
- **The studio has no chat surface at all.** `features/agents/agents-panel.tsx`
  inspects `@lunora/agent` THREADS — it is a read model over someone else's runs,
  not a place an operator talks to anything.

## 2. Existing seams (do not reinvent)

- **`auth-audit-rpc.ts` is the template**, structurally: a `*_OP` constant, a
  `*RpcDeps` closure interface (`assertAdmin` + a getter for the injected
  capability), a builder returning the handler, and a `*_NOT_CONFIGURED` 400 when
  nothing is wired. Copy that shape; do not invent a second worker-RPC idiom.
- **`sql-assistant.ts`'s engine.** `runPrompt`, `attempt`, `UNTRUSTED_FENCE`,
  the per-field caps, the two degrade arms, and `AiRunBinding` (a structural
  projection of the Workers `AI` binding, declared locally so no dependency edge
  is created). All of it is host-neutral already — it takes an injected binding
  and returns values rather than throwing.
- **`shared/sql-readonly.ts`.** Any statement the assistant produces passes the
  same gate `runSql` enforces, unexecuted, exactly as today
  (`sql-assistant.ts:19-23`).
- **`useAdminQuery` / `adminRef` / `callOptions`.** A worker-served op is
  indistinguishable from a shard-served one at the call site — `getAuthAuditLog`
  proves it — so the studio needs no new client transport.
- **`useSqlAssistant`'s availability latch.** `aiAvailable` is asked once on
  mount and `no-ai-binding` is sticky, so every affordance disappears rather than
  staying as a button that always fails. The chat surface reuses that, it does
  not re-derive it.

## 3. The behavioural contract to preserve

- **Nothing the model produces is privileged.** Generated SQL is returned
  UNEXECUTED and must pass `classifyStatement`. A tool that reads is served by
  the existing gated admin op; there is no path from a model response to a write.
- **No row values leave the deployment without the operator asking.** Today
  `inferChart` sends column names, types and row count only
  (`use-sql-assistant.ts:33-36`). A chat turn that quotes a result must be an
  explicit operator action, not an automatic context attachment.
- **Degrade, never throw.** Every failure arm returns a reason the UI renders;
  `no-ai-binding` stays sticky and hides the surface.
- **The three existing RPCs keep working unchanged.** The SQL bar, the filter
  bar and the chart inference are separate affordances with their own status, and
  this plan adds a fourth surface rather than replacing them.
- **`assertAdmin` runs FIRST**, before any not-configured check, so an
  unauthenticated caller cannot probe whether the feature is wired
  (`auth-audit-rpc.ts:108-111` states this rule and why).

## 4. Design decisions

**Worker-served `__lunora_admin__:aiChat`, not a DO handler.** Chosen over
registering it on `aiAdminHandlers()` beside its three siblings, which would be
the smaller diff and would violate the one constraint that made this a separate
plan. The DO is single-threaded; a multi-turn exchange held open there blocks
every other admin read for its duration.

**Worker-served op, not `@lunora/agent` over Workflows.** Rejected because of
what it would require of the app, not because of what it can do: a Workflows
binding, an installed add-on, and a generated agent class, for a console session
nobody resumes. Durability and HITL approvals are real features of that package
and they answer a question the Studio does not ask. **Revisit if and only if**
tool-calling grows a write tool — approvals are the right machinery for that, and
that is the moment the trade flips.

**History is client-held and re-sent, not server-persisted.** Chosen over a
threads table. A studio chat is a scratchpad: the operator closes the tab and the
conversation is over. Persisting it means a schema, a retention policy, and — per
[363] W7's finding — another store of raw statements outliving the browser. The
cost is that each turn re-sends the transcript, which forces an explicit cap
(§5 W2) rather than letting context grow unbounded.

**Every prior turn is untrusted input.** The existing `UNTRUSTED_FENCE` wraps
caller-supplied fields; a re-sent transcript is caller-supplied by definition,
including the parts that claim to be previous assistant output. Fence and cap
each turn the same way a first prompt is fenced — a transcript the browser could
forge is not a privileged channel.

**Read-only tools only, and only ones that are already gated admin ops.** The
model may ask to `describeTables` or to run a `classifyStatement`-passing
`runSql`; it may not do anything with no existing admin op behind it. This keeps
the security review to "does the existing gate still hold" rather than "is this
new capability safe".

**Streaming is deferred to its own workstream and is not on the critical path.**
A turn that returns whole is a complete feature; a turn that streams is the same
feature with better latency perception. Building the transport for streaming
first is how the simple version never ships.

## 5. Workstreams

- **W1 (M) — Done.** Shipped as `154068e99`.
  `shared/sql-assistant.ts` answers open question 1: the engine's only import was
  `shared/sql-readonly`, so it moved to `shared/` rather than creating a
  `@lunora/runtime` → `@lunora/do` edge. `@lunora/do`'s API snapshot did not move.
  Original text follows.

    **The worker-served op.** `__lunora_admin__:aiChat` in a new
    `packages/runtime/src/ai-chat-rpc.ts`, built on `auth-audit-rpc.ts`'s shape:
    `assertAdmin` first, `AI_CHAT_NOT_CONFIGURED` (400) when no `AI` binding is
    wired, and the `sql-assistant.ts` engine for the inference itself. One turn in,
    one turn out, no tools yet. Gate: a chat turn completes while a concurrent
    `runSql` against the same shard returns within its normal latency — the whole
    reason this op is here.

- **W2 (S) — Done.** Shipped as `154068e99`. Two budgets, not one: a thousand
  one-character turns pass a character cap and twelve enormous ones pass a turn
  cap, so either alone is escapable. Original text follows.

    **Transcript caps and fencing.** A cap on turns and on total
    characters, applied server-side (a client cap is a suggestion), with every turn
    inside the existing untrusted fence. Gate: a transcript over the cap is
    truncated oldest-first and the response says so; a turn containing the fence
    marker verbatim does not escape it.

- **W3 (M) — Done.** Shipped as `76d220e09`. One deviation: the fenced-SQL
  reader is a linear split, not a regex — the obvious pattern is
  polynomial-backtracking, and a model reply is exactly the input not to hand an
  ambiguous matcher. Answers open question 3: not persisted, not even to
  `sessionStorage`. Original text follows.

    **The chat surface.** A panel in the SQL console reusing
    `useSqlAssistant`'s availability latch, with the transcript in React state (not
    `localStorage` — see §4). "Insert into editor" is the only path from a response
    to the editor, so nothing runs without a click. Gate: with no AI binding the
    surface does not render; a response containing SQL offers insertion and never
    execution.

- **W4 (M) — Done.** Shipped as `daa0b8493`. Answers open questions 2 and 4: the
  tool reads the shard the console has open, echoed back in `toolCalls`; and
  reaching the cap answers with what it has, marked `partial`, rather than
  erroring away the work. Original text follows.

    **Read-only tool calls.** `describeTables` and gated `runSql` as
    tools, dispatched server-side within the turn, each result fed back into the
    loop with a per-turn call cap. Gate: a tool call that fails
    `classifyStatement` is refused inside the loop and reported, not retried into
    a different statement.

- **W5 (S→L) — BLOCKED, and mis-sized here.** See §8b: the only streaming
  primitive in the repo is DO-bound, so W5 needs a transport that does not exist
  rather than the reuse this (S) assumed. Original text follows.

    **Token streaming.** Only after W1–W4. Gate: an interrupted stream
    leaves no partial turn in the transcript.

## 6. Platform parity

This adds no `ctx.*` surface and no new binding: it reads the same `AI` binding
`ctx.ai` and the existing assistant RPCs already use, through the same structural
`AiRunBinding` projection (`sql-assistant.ts:80-86`) that exists so `@lunora/do`
needs no edge on `@lunora/ai`.

| Feature                   | `cloudflare` | `node`      | Notes                                                                                                                                                                                                                                 |
| ------------------------- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__lunora_admin__:aiChat` | native       | unsupported | Needs a Workers `AI` binding. The Node host has none, and the op already degrades with `AI_CHAT_NOT_CONFIGURED` when the binding is absent — which is the same answer, reached by the path that already exists rather than a new one. |

The row is worth stating even though the answer is "cloudflare only": the studio
is served against both hosts, and an operator on the Node host must get the
not-configured degrade rather than a surface that fails on click.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                         |
| ----- | ---- | ---------------------------------------------------------------------------- |
| 0     | W1   | Concurrent `runSql` latency unchanged during a chat turn                     |
| 1     | W2   | Over-cap transcript truncated oldest-first and reported; fence not escapable |
| 2     | W3   | No AI binding → no surface; SQL is insertable, never executable              |
| 3     | W4   | A gate-failing tool call is refused in-loop and reported                     |
| 4     | W5   | An interrupted stream leaves no partial turn                                 |

W1's gate is the one that matters and it is the one that is easy to skip, because
it passes trivially in a unit test and only fails under concurrency. Measure it
against a real DO with a slow model double, not a mock that resolves immediately.

## 8. Risks & STOP conditions

- **STOP** if the op ends up registered in `aiAdminHandlers()`. That is the
  single constraint this plan exists to honour; if the Worker cannot reach what
  the handler needs, the answer is to pass it in as a closure dep the way
  `AuthAuditRpcDeps` does, not to move the handler to the DO.
- **STOP** if a tool gains a write. Read-only tools keep the security question to
  "does the existing gate hold". A write tool is a different plan, and it is the
  point at which `@lunora/agent`'s approvals stop being over-engineering.
- **Risk:** the transcript grows until a turn exceeds the model's context and the
  whole conversation starts failing. Mitigate: W2's cap is server-side and lands
  before the surface (W3), not after.
- **Risk:** the chat becomes a second place where SQL is generated, drifting from
  `aiGenerateSql`'s prompt and caps. Mitigate: it reuses `runPrompt`/`attempt`
  from `sql-assistant.ts` rather than adding a second inference primitive — the
  same argument that module's own docblock makes.
- **Perf watch:** concurrent `runSql` p99 during a chat turn. That number is the
  entire justification for the transport choice, so it is the one to record.

## 8b. Found while executing

- **W5 cannot reuse `client.stream()`, and its (S) rating assumed it could.**
  The client has a streaming primitive (`lunora-client.ts:3313`), but it rides
  the subscription WebSocket and is answered by the DO —
  `shard-do.ts:4535` is what handles a `type: "stream"` envelope. Using it for
  this op would route the conversation back through the single-threaded admin
  dispatch, which is the STOP condition in §8 and the entire reason this plan
  exists.

    There is no other streaming path to borrow: `text/event-stream` appears
    nowhere in `packages/runtime` or `packages/studio`. So W5 means a new
    worker-side streaming response **and** a client reader that bypasses
    `client.query`, which is a transport workstream, not the (S) this plan rated.

    Deliberately not built as part of this change. §4 already says a turn that
    returns whole is a complete feature and that building the transport first is
    how the simple version never ships — that argument applies just as well to
    building it last, in the same change, unreviewed. **Re-plan W5 on its own.**

- **The chat op needed the RPC envelope from the start.** Worker-served ops must
  answer `{ result: encodeWire(...) }`; a bare body decodes to `undefined` and
  TanStack Query rejects that outright. Both existing worker-served ops shipped
  this wrong (fixed in #427), so this one was written against the corrected
  contract rather than rediscovering it.

## 9. Open questions (answer during execution)

1. Does `sql-assistant.ts` need to move out of `@lunora/do` for the Worker to use
   it, or can `@lunora/runtime` import it? It is already a pure unit over an
   injected binding, so the blocker is packaging, not design — check whether
   `@lunora/runtime` may depend on `@lunora/do` in that direction.
2. Which shard does a chat turn's `runSql` tool target — the one the console has
   open, or must the operator name it per call? Leaning "the open one, echoed in
   the response", so the answer is never ambiguous about what it read.
3. Should the transcript survive a tab reload within a session
   (`sessionStorage`), or not at all? §4 argues not persisted; `sessionStorage`
   is the middle answer and W7 of [363] already established the helper.
4. What is the per-turn tool-call cap, and does exceeding it fail the turn or
   return what it has? A partial answer that says it is partial is probably
   better than an error, but that is a UX call to make with the surface in front
   of you.
