# Plan 364 — A conversational assistant for the Studio, off the DO admin dispatch

**Baseline:** `3a2e83d89` (2026-08-19)
**Status:** W1–W4 SHIPPED; W5 BLOCKED — see §8b. W6–W8 SHIPPED — see §10. W9–W10
SHIPPED — see §11. The
conversational assistant works end to end and is now reachable from the whole
Studio rather than the SQL console; only token streaming is outstanding, and it
needs a transport that does not exist yet.
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

    **Revised by W4 — say so rather than let it drift.** A `runSql` tool result is
    row values, chosen by the MODEL and attached with no operator click, which is
    the opposite of the rule above. That is the deliberate substance of W4, not an
    oversight, and the boundary it actually holds is narrower: values never leave
    the deployment (the model runs on the app's own binding), never reach the
    browser except inside a reply the operator reads, and only ever come from a
    statement that passed the read-only gate. The surface now reports when a turn
    read data, so the operator can see it happened. `generateChart`'s stricter rule
    is unchanged — it still sends shape only.

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

## 10. W6–W8 — the shell-wide assistant (shipped after the original plan)

The original plan built the surface where the transport landed: one panel, inside
the SQL console. That was the right first step and the wrong final shape — a
transcript that dies on navigation is one nobody keeps using, and no other page
could reach it at all. Three workstreams closed that.

- **W6 (M) — The seam.** `AssistantProvider` (`packages/studio/src/components/`)
  holds sessions and open state above the router, modelled directly on
  `OperationConsoleProvider` — including its `undefined`-outside-a-provider
  contract, so a bare-composed Studio panel offers no button rather than a dead
  one. Any surface opens it with `openAssistant({ ask | draft, schema, shardKey,
title })`. The panel moved to `features/assistant/assistant-panel.tsx` and is
  docked by `StudioLayoutShell` beside the routed page, **outside its error
  boundary** — an assistant that vanishes when the page it is discussing throws
  cannot be asked about the error.

    The one thing the panel cannot know is where a suggested statement should go,
    so the PAGE registers an insert target (`setInsert`) and withdraws it on
    unmount. On every page without an editor the Insert button is simply not
    rendered.

    `useSqlAssistant` moved to `hooks/use-assistant-ops.ts` as `useAssistantOps`:
    it was already consumed by the data browser and the reports builder, so its
    home under `features/sql/` was an accident, and the shell-wide panel would
    have made it a cycle.

- **W7 (M) — Data-sharing levels.** The single `unavailable` latch became an
  ordered ladder — `disabled` → `schema` → `schema_and_log` →
  `schema_and_log_and_data` — with a tier per tool (`TOOL_LEVEL` in
  `shared/sql-assistant.ts`) and `readLogs` added at the log tier over the
  existing `__lunora_admin__:getLogs` op. Two consequences worth stating:

    - **The prompt is built from the level.** A tool the level refuses is never
      advertised, because advertising it guarantees the model asks and burns a
      round of the per-turn budget on a refusal every turn. A model that asks
      anyway gets a refusal naming the tier, so it can tell the operator what to
      change.
    - **The level is server-side and defaults to `schema`.** It reads
      `env.LUNORA_AI_OPT_IN` through `WorkerOptions.aiOptInLevel`; an unrecognised
      value falls back to the default rather than the top tier. This is a
      deliberate behaviour change to W4: the operator already holds an admin
      bearer and could run any read statement themselves, so the gate is not
      protecting them from their own database — it decides whether rows their END
      USERS wrote reach an inference provider, and a disclosure defaults to off.

    No transcript sanitiser was needed for tool OUTPUT: the transcript carries prose
    turns only, and a tool result lives inside one turn's server-side prompt and
    never re-enters the client-held history. The narrower true statement, since the
    first draft of this section overstated it: a reply produced at
    `schema_and_log_and_data` may _quote_ the rows it read, and that prose does
    re-enter the transcript and is re-sent on later turns. Lowering the level with
    a tab still open keeps sending those quotes until the session is dropped.
    Narrow — sessions die on reload, and the data already reached the same provider
    — but the invariant is "raw tool output never replays", not "nothing from a
    higher level ever replays".

- **W8 (S) — Distribution and two readers.** `ErrorAlert` gained "Ask the
  assistant", which is the highest-leverage entry point in the Studio: every panel
  that can fail already renders it, so one button reaches all of them. `AdvisorView`
  gained a per-finding ask (Performance + Security advisors, one edit). The command
  palette gained a toggle, since the panel has no route. The SQL console gained
  "Explain this query" and, on the Explain tab, "Read this plan" — the plan rows
  travel, because a plan the operator can see and the model cannot is the thing
  they are asking about.

## 11. W9 — reading the reply, and a way in

- **Markdown.** Replies were preformatted text, so every answer carrying a list, a
  table or a fenced block arrived as a wall of syntax — which is most of them.
  `streamdown` renders them, chosen over `react-markdown` (whose API it is
  compatible with) for the hardening it ships, because what is rendered here is
  model output. A QUESTION is still shown exactly as typed: markdown-rendering the
  operator's own words would be the surface reinterpreting their input. Measured
  rather than assumed — +484K, in a chunk the entry does not statically reach, and
  mermaid/shiki/katex are not bundled at all.

    Images are DROPPED, not merely sanitized. `rehype-harden` blocks a
    `javascript:` link but allows every image protocol and prefix, and an image URL
    in model output is a beacon: it fires on render and carries whatever the model
    put in it — which, since a turn can read rows, is whatever it just saw.

- **What a turn did, per turn.** The panel printed one line for the whole session,
  so a turn that ran three statements and one that invented an answer looked
  identical, and a refusal looked like nothing. Tool calls now ride on a
  studio-local `SessionTurn`, never on the wire turn: the transcript the server
  budgets is prose, and handing it back a log of its own calls would spend that
  budget on what it already knows.

- **A way in.** Starter questions come from the surface that opened the panel — the
  SQL console builds them from the schema it has PROBED, so they name real tables.
  Plus copy / branch-from-here / delete-from-here on each turn.

- **`readAdvisors`** over the existing `getAdvisories` op, at the `schema` tier: an
  advisory names a table and a rule and carries no rows, so gating it higher would
  withhold the one thing the model can say about an app it is otherwise guessing
  at. It is the default tier, so it is the first tool that improves an
  out-of-the-box deployment's answers.

## 12. W10–W11 — the operator gate, and something to be right about

Two things §3 left open, closed together because they are the same complaint from
opposite ends: the turn read things nobody asked it to, and it had nothing true to
say about the framework it was reading them in.

- **W10 (M) — Approval before a tool reads rows.** §3 recorded W4's boundary honestly
  and it was still the wrong boundary: `runSql` puts row values chosen by the MODEL
  in front of an inference provider with no operator gesture anywhere in the loop.
  Closed by making the turn STOP.

    The op is one request/response and W5 is blocked, so a turn cannot wait
    server-side for a click. Three shapes were weighed. A second op to poll for a
    decision is W5's transport problem in a smaller hat. Making the panel pre-approve
    a statement before sending puts the decision before the model has proposed
    anything, which is nothing to judge. What shipped is the third: the turn RETURNS
    `pendingApproval` instead of dispatching, the panel renders the statement with
    Allow/Deny, and the answer starts a follow-up turn carrying it. `MAX_TOOL_CALLS`
    is unchanged, so the cost of stopping is one extra round trip, not a new budget.

    **The forgery question, and why the ticket exists.** Everything the browser sends
    on this op is caller-supplied, including a boolean claiming the operator said
    yes. So the approval carries no statement of its own — only a ticket, an
    HMAC the server minted over the exact statement it proposed, verified against the
    statement the model asks for on the follow-up turn. An approval the browser
    invents unlocks nothing, and a real ticket replayed against a different statement
    unlocks nothing either. The signing key is random per isolate, because the only
    other secret this op has is the admin token and the browser holds that. The
    ceiling is stated where it lives (`shared/ai-chat.ts`): a recycled isolate
    invalidates outstanding tickets, and the failure is one-directional — an
    unrecognised ticket reads as "not approved", so the card comes back and nothing
    runs unapproved.

    **Order.** `classifyStatement` runs BEFORE anything is shown, so a write is
    refused in the loop and never becomes a card asking an operator to approve
    something the gate would refuse anyway. Deny is a real answer, not a dismissal:
    the model is told it was declined and answers from what it has.

    **Only `runSql`.** `describeTables` and `readAdvisors` return no row values.
    `readLogs` was the close call and the answer is no: its scope is fixed and its
    disclosure was already chosen at deploy time by picking `schema_and_log`, so a
    card there would say the same thing every turn with no parameter to weigh — and a
    click-through habit is exactly what would get the `runSql` card approved unread.

- **W11 (S) — `loadKnowledge`.** The assistant knew the operator's schema, logs,
  advisories and rows, and nothing whatsoever about Lunora, so it answered framework
  questions by inventing APIs — confidently, into a console that then offers to
  insert the result into an editor.

    The content is DERIVED, not written: `scripts/build-ai-knowledge.js` compiles
    `apps/docs/src/content/docs` into `shared/ai-knowledge-data.ts`, and
    `scripts/check-generated-files.mjs` fails the build if the committed digest
    stops matching the docs. What travels is an index — title, the reviewed
    frontmatter `description`, the `##` headings (largely API names in these docs),
    and the page URL — because a tool result is capped at 2,000 characters and every
    byte ships in every deployed Worker. ~29 KB of data, against the 50 KiB
    `worker-size.json` allowance.

    Tiered at `schema`, the lowest rung a tool can hold: it discloses nothing about
    the deployment. A "docs only" rung below it would gate nothing, since `disabled`
    already ends the turn before any tool is reached.

## 13. Found while executing W6-W11

- **The standalone bundle had been shipping DEVELOPMENT React and could not stop.**
  `build-standalone.mjs` probe-builds under production React and falls back if the
  dev JSX runtime is still needed — but it decided by grepping output TEXT for the
  identifier, which cannot tell a hazard from a mention. Two harmless mentions
  enter the graph as soon as anything renders markdown: `hast-util-to-jsx-runtime`
  guards on an options property of that name, and React's own production
  dev-runtime shim assigns it `void 0`. `dist:check` had the same flaw. Both now
  key on whether React's dev JSX runtime is in the graph — an import, not an
  identifier. Nothing had shipped: `@lunora/studio` on npm is a placeholder and the
  published CLI does not embed the bundle.

- **The playground's Workers AI binding killed the entire E2E suite.** That binding
  has no local emulation, so declaring it opens a remote proxy session needing a
  Cloudflare API token; without one the dev server does not boot, so every
  Playwright test fails rather than just the AI ones. Removed — the no-binding path
  is the designed and tested one.

- **Access-only admins could not use ANY worker-served admin op.** `applyAdminGate`
  skips the RPC path to keep the gate off the data hot path, but `aiChat`,
  `getAuthAuditLog` and `listPushSubscriptions` are all reached over exactly that
  path, so no grant was ever recorded. Pre-existing, fixed here: the gate now runs
  keyed on the envelope's admin prefix, so ordinary calls still never pay for it.

**Deliberately not built.** Session persistence: §4's argument is unchanged, and
sessions surviving navigation (which is what was actually missing) does not
require surviving a reload. Inline diff-editing in the editor gutter — the SQL
editor is a `<textarea>`, so that is an editor decision before it is an AI one.
RLS policy authoring — a write tool, which hits the §8 STOP condition and stays
its own plan. Token streaming remains W5, still blocked on a transport (§8b).
