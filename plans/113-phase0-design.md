# Plan 113 — Phase 0 design: durable AI-agent primitive (`defineAgent`)

> **Spike outcome (TL;DR)**: Every part of a durable tool-loop maps onto a **shipped**
> Lunora primitive — durable steps (`ctx.runStep` → native `step.do`), DO SQLite
> thread tables, the WS `type:"stream"` transport, and (plan 111) `rag.retrieve`.
> Replay-safety for **completed** steps is guaranteed by native `step.do`
> memoization; a **failed/retried** side-effecting tool still needs an idempotency
> key, which the deterministic step name provides. **No STOP** — but the honest
> recommendation is **document-first / opt-in add-on, not a core primitive**,
> because this is a _user-facing_ surface in tension with the "scale invisibly"
> north star. That tension is the **top open question** for the maintainer (§7.1).
>
> PoC: `plans/proto/agent/agent-loop.ts` (+ passing test asserting thread ordering
> **and** resume-doesn't-re-run-a-completed-tool). Ran green in-sandbox.

---

## 1. Machinery map — each loop part → a shipped primitive

| Agent-loop part                                  | Reused Lunora primitive                                           | Reference                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM turn** (call model, get text or tool-call) | a **named durable step**                                          | `ctx.runStep(defineStep("llm:turn:N", …))` → `deps.step.do("llm:turn:N", cb)` — `packages/workflow/src/run-step.ts:130`; `define-step.ts:40`                                                                                                                                                   |
| **Tool call** (execute a tool)                   | a **named durable step** (name = idempotency key)                 | same `ctx.runStep`; step name `tool:<name>:<callId>`                                                                                                                                                                                                                                           |
| **Message persist** (user/assistant/tool rows)   | **DO SQLite table write**, idempotent by deterministic message id | `defineSchema` tables + `ctx.db`; shipped idempotency machinery `packages/do/src/ctx-db-idempotency.ts`                                                                                                                                                                                        |
| **Stream deltas to client**                      | WS **`type:"stream"`** transport                                  | authored as a `query(...).stream()` async generator — `packages/server/src/builder/types.ts:67` (`RegisteredStream`); dispatched by `packages/do/src/shard-do.ts:2261` `handleStream`; consumed client-side via `createStream`/`StreamIterable` — `packages/client/src/lunora-client.ts:18-19` |
| **Memory / RAG step**                            | `defineRag(...)(ctx).retrieve` (plan 111)                         | returns `{ context, chunks, sources }` — designed for this consumer                                                                                                                                                                                                                            |
| **Loop orchestration** (durable, replayable)     | Cloudflare Workflows via `@lunora/workflow`                       | `defineWorkflow` + `createWorkflowContext` — `packages/workflow/src/index.ts`                                                                                                                                                                                                                  |
| **Fan-out / parallel tools + saga rollback**     | shipped `branch`/`MAX_BRANCHES` + step `rollback`                 | `fan-out.ts`; `run-step.ts:113-128` (rollback wiring)                                                                                                                                                                                                                                          |
| **Duplicate-step-name guard**                    | shipped workflow lint                                             | keep agent step names unique + deterministic                                                                                                                                                                                                                                                   |

**Nothing new is required at the runtime layer.** The agent loop is an
_assembly_ of these. That fact is the crux of the build-vs-document decision (§7.1).

---

## 2. Replay-safety / idempotency argument (the correctness core)

### 2.1 What native `step.do` guarantees

`run-step.ts:130` runs each step as `deps.step.do(step.name, callback, …)` —
Cloudflare Workflows' native durable step. Its contract: **a step that has already
completed is memoized by name; on a resume/replay the recorded output is returned
WITHOUT re-invoking the callback.** So if the workflow crashes after a tool step
committed, the resumed run **does not re-run that tool** — a card is charged once.

Each LLM turn and each tool call is a **uniquely + deterministically named** step:

- `llm:turn:<n>` — `n` is the loop turn index (deterministic across replays).
- `tool:<name>:<callId>` — `callId` is the **provider's stable tool-call id** from
  the LLM response (deterministic — it is itself replayed from the memoized
  `llm:turn` output).

Determinism of the **loop control** matters: which steps run is derived from
**persisted step outputs** (the memoized `llm:turn` decisions), never from fresh
`Date.now()`/`Math.random()` at the top level. Non-determinism _inside_ a step body
is fine — the body's output is memoized. (Lunora already flags top-level
non-determinism via the `nondeterministic_query_mutation` advisor lint.)

The shipped **duplicate-step-name lint** is the guard that keeps names unique; the
agent's naming scheme (`llm:turn:<n>`, `tool:<name>:<callId>`) is compatible with
it.

### 2.2 The nuance the design must NOT hide — retry ≠ replay

`step.do` memoizes on **success**. A step whose body **fails mid-execution** (after
a side effect, before the step records completion) is **retried at-least-once** —
and re-run. So:

- **Replay of a COMPLETED step** → safe (memoized). ✅
- **Retry of a FAILED, side-effecting step** → the tool body must be **internally
  idempotent**. This is _not_ a Lunora gap — it is the same at-least-once reality
  in Temporal/Convex/every durable-execution engine. The standard answer is an
  **idempotency key**, and the agent already has a perfect one: **the deterministic
  step name** (`tool:<name>:<callId>`). The design hands that key to the tool
  (e.g. as `ctx.idempotencyKey`) so a payment/side-effecting tool dedupes.

**Therefore the STOP condition "the durable-step machinery can't guarantee tool
idempotency across replays without changes to `@lunora/workflow`" does NOT
trigger**: across _replays_ it is guaranteed by memoization; across _retries_ it is
handled by the idempotency-key convention with zero engine change. The follow-up's
first task is to **document + surface the idempotency key**, and optionally add a
tiny `defineTool({ idempotent: true })` helper — a convenience, not a correctness
prerequisite. This is open question §7.2.

### 2.3 PoC evidence

`plans/proto/agent/agent-loop.ts` models the loop and a faithful
`DurableStepJournal` (an exact in-memory model of `step.do` memoization — a step
name with a recorded output returns it without re-invoking `cb`, persisted across a
resume by reusing the journal instance). The test (`agent-loop.test.ts`, **ran
green**) asserts:

- **(a) thread ordering**: messages persist as `user → assistant(tool_call) → tool
→ assistant(final)` with monotonic `seq`, correct `toolCall`/`toolCallId`
  correlation, and the tool ran exactly once.
- **(b) resume safety**: a simulated crash **after** the tool step commits (before
  turn-1's LLM call) is followed by a resume with the **same** journal + message
  store; the resumed run serves `llm:turn:0` and `tool:getWeather:call_1` from the
  journal — the tool's side-effect counter stays **1**, each step body was invoked
  **exactly once** across crash+resume (`["llm:turn:0","tool:getWeather:call_1","llm:turn:1"]`),
  and the final thread has no duplicated messages (idempotent upsert by message id).

What was mocked: the LLM + the tool + Cloudflare Workflows itself (unreachable
in-sandbox). The memoization contract modelled is the _documented_ `step.do`
behavior that `run-step.ts:130` delegates to, so the replay-safety argument holds
for the real machinery.

---

## 3. The API + thread schema

### 3.1 `defineAgent`

```ts
// lunora/agents.ts
import { defineAgent } from "@lunora/agent"; // recommended home — §7.1
import { tool } from "@lunora/ai";
import { docs } from "./rag"; // plan 111

export const support = defineAgent({
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // string id or AI SDK model
    thread: "supportThreads", // thread table name (see §3.3)
    tools: {
        getWeather: tool({/* AI SDK tool: description, inputSchema, execute */}),
    },
    memory: docs, // optional: a defineRag index → auto retrieval step (§4)
    maxSteps: 8, // cost/step cap
    // idempotentTools: ["charge"],   // §7.2
});
```

### 3.2 Runtime surface — how an app invokes it

The loop needs `ctx.runStep`, which only exists inside a **workflow run**. So
`defineAgent` **compiles to a generated `defineWorkflow`** whose handler runs the
loop. The app invokes it like any workflow producer:

```ts
// inside an action/mutation:
const run = await ctx.agents.support.run(threadId, { message: input }); // → creates a workflow instance
// stream deltas to the client with a paired streaming query (§4):
// useStream(api.agents.support.stream, { threadId })
```

_Recommendation_: `ctx.agents.<name>.run(threadId, input)` (mirrors
`ctx.workflows`/`ctx.queues` producer style) over a bare action, so the durable
workflow instance + status are first-class. The streamed response is a **separate**
`query(...).stream()` the client subscribes to by `threadId` (§4).

### 3.3 Thread + message schema (`defineSchema` tables in the DO)

```ts
export default defineSchema({
    agentThreads: defineTable({
        agent: v.string(),
        title: v.optional(v.string()),
        createdAt: v.number(),
        status: v.union(v.literal("idle"), v.literal("running"), v.literal("error")),
    }).index("by_agent", ["agent"]),

    agentMessages: defineTable({
        threadId: v.id("agentThreads"),
        seq: v.number(), // monotonic per-thread ordering
        role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system")),
        content: v.string(),
        toolCall: v.optional(v.object({ id: v.string(), name: v.string(), args: v.any() })), // assistant → tool intent
        toolCallId: v.optional(v.string()), // tool row → correlates to toolCall.id
        stepName: v.optional(v.string()), // the durable step that produced it (audit/idempotency)
        createdAt: v.number(),
    }).index("by_thread", ["threadId", "seq"]),
});
```

Message writes are **idempotent by a deterministic id** (`stepName` or
`${threadId}:${role}:${turn}`) so a replay re-persist does not duplicate — the PoC
proves this, and the shipped `ctx-db-idempotency.ts` provides the mechanism.

---

## 4. Streaming + memory integration

- **Streaming**: author the agent's live response as a `query(...).stream()` async
  generator (`RegisteredStream`, builder/types.ts:67) that yields token/tool-event
  deltas; the DO's `handleStream` (shard-do.ts:2261) delivers them as
  `ServerChunkMessage` frames over the existing WS `type:"stream"` transport; the
  client consumes via `createStream`/`StreamIterable`. **No new transport.** The
  stream reads from the persisted thread + in-flight step outputs, so a reconnect
  resumes from the durable state.
- **Memory/RAG (plan 111)**: `memory: docs` inserts a retrieval step at turn start
  — `docs(ctx).retrieve(userMessage)` — and injects `.context` into the model
  prompt (and can be exposed as an AI SDK `tool()` so the agent _chooses_ to
  retrieve; plan 111 §6.6). `retrieve`'s `{ context, chunks, sources }` shape was
  designed for exactly this.

---

## 5. STOP-condition assessment

| STOP condition                                                                                            | Triggered?                                                 | Notes                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Durable-step machinery can't guarantee tool idempotency across replays without `@lunora/workflow` changes | **No**                                                     | Completed-step memoization is native (§2.1); retry needs an idempotency key = the deterministic step name, no engine change (§2.2). |
| Design surface balloons (streaming + HITL + memory + cost caps each open sub-designs)                     | **Expected for XL → surfaced as open questions**           | §7 scopes them; recommend a phased build, not an attempt here.                                                                      |
| "Scale invisibly" argues against a bespoke user-facing primitive                                          | **This is the real tension → §7.1, the TOP open question** | Honest outcome may be "document the composition; ship at most an opt-in add-on."                                                    |

No hard STOP. The spike's job is to make the build-vs-document call _decidable_ — §7.

---

## 6. HITL, cost caps, cancellation (noted, not designed)

- **Human-in-the-loop**: Cloudflare Workflows' `waitForEvent` pauses the run until
  an external event (approval) arrives — a natural fit for a `pause`/`resume`
  tool. Design in the build phase.
- **Cost/step caps**: `maxSteps` (turns) + a token/$ budget checked between turns;
  exceed → terminate with a persisted `status:"error"`.
- **Cancellation**: the streaming query's `AbortSignal` + a workflow terminate.

---

## 7. Open questions (maintainer decisions)

### 7.1 (TOP) Build a bespoke `defineAgent` primitive, or document the composition? — the "scale invisibly" tension

This is a **user-facing primitive**, unlike the invisible runtime elasticity the
north star prizes. §1 shows the loop is a _thin assembly_ of shipped primitives.
That pulls two ways:

- **Against building** (north-star-aligned): the composition is genuinely thin; a
  bespoke primitive **locks in opinions prematurely** (thread schema, tool
  protocol, streaming shape, HITL semantics) that are still moving industry-wide;
  and it adds core user-facing surface that a good **recipe/example + a tiny
  helper** could cover without commitment.
- **For building** (parity/marketing): the assembled agent primitive is Convex's
  **most-marketed differentiator** (`@convex-dev/agent`). "Build an agent on my
  backend" is the current top AI use case; a first-class `defineAgent` is a
  headline capability, and leaving it as docs concedes the comparison.

**Recommendation (for the maintainer to ratify, not a unilateral decision)**:
**document-first, then ship a MINIMAL `defineAgent` as an OPT-IN add-on package
`@lunora/agent`, not in core `@lunora/ai`.** Concretely, phased:

1. **Now**: a documented "durable agent" recipe/example composing
   `@lunora/workflow` + `@lunora/ai` + `defineRag` (plan 111), plus a tiny
   `runAgentLoop(...)` helper in `@lunora/ai` (the PoC, hardened). Zero new
   user-facing primitive → keeps core invisible.
2. **After the recipe validates demand**: graduate to `@lunora/agent`'s
   `defineAgent` (§3) as an **opt-in add-on** (like `@lunora/auth`/`@lunora/mail`),
   so the _core_ stays invisible while power users get the assembled primitive.

Rationale: the add-on boundary is exactly how Lunora keeps its core small while
still shipping big capabilities — building `defineAgent` as an _opt-in package_
resolves the tension rather than compromising the core. **But the placement and the
build-vs-document sequencing are the maintainer's call — this design is the
artifact for that decision.**

### 7.2 Idempotency-key convention for side-effecting tools (§2.2)

_Recommendation_: pass the deterministic step name to the tool as
`ctx.idempotencyKey`; optionally a `defineTool({ idempotent })` marker. Document
loudly — a tool that runs twice on a _retry_ (not a replay) is the correctness
cliff. No `@lunora/workflow` change required.

### 7.3 Home: `@lunora/ai` vs new `@lunora/agent`

_Recommendation_: new **`@lunora/agent`** opt-in package (§7.1) — keeps the loop's
opinions out of the lean `@lunora/ai`.

### 7.4 Memory/RAG integration shape

_Recommendation_: `memory: <defineRag>` auto-injects a retrieval step **and**
exposes `retrieve` as a `tool()` the agent may call (plan 111 §6.6). Sequence 111
first.

### 7.5 HITL via `waitForEvent` (§6) — in v1 or deferred? _Recommendation_: deferred to v2.

### 7.6 Streaming transport details — token deltas + tool-call events over one

`type:"stream"` query, keyed by `threadId`; confirm the delta envelope schema.

### 7.7 Cost/step caps + cancellation (§6) — the default `maxSteps` and budget policy.

---

## 8. Cross-plan sequencing

- **Sequence 111 (RAG) before any 113 build** — the agent memory step consumes
  `defineRag(...).retrieve` (plan maintenance note).
- Reuse the shipped **fan-out/saga** (plans 075/076) + the **duplicate-step-name
  lint**; keep agent step names unique + deterministic (§2.1).
- If built, this is the flagship Convex-parity AI feature — this design doc is the
  decision artifact for build-vs-document (§7.1).
