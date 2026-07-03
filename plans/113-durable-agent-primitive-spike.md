# Plan 113: [Spike] Durable AI-agent primitive (`defineAgent` — tool-loop + persisted thread)

> **Executor instructions**: This is a DESIGN/SPIKE plan for an XL feature. The
> deliverable is a design document + a minimal proof-of-concept — NOT a shipped
> `defineAgent`. Follow the steps, produce the artifacts, and STOP at the open
> questions for a maintainer decision. This touches the "scale invisibly" north
> star (it is a user-facing primitive), so the design must be deliberate. Update
> `plans/README.md` when the spike is complete.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/ai packages/workflow packages/do`

## Status

- **Priority**: P2 (as a spike; the build is a later, larger decision)
- **Effort**: XL (spike is L)
- **Risk**: MED–HIGH
- **Depends on**: none (relates to plan 111 RAG for the memory step)
- **Category**: direction (feature / spike)
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

"Build an agent on my backend" is the current top-of-mind AI use case and Convex's
most-marketed differentiator (`@convex-dev/agent`: threads + durable tool-loop +
RAG). `@lunora/ai` today ships only `create-ai.ts`, `index.ts`, `types.ts` and
re-exports the raw AI SDK primitives (`generateText`/`streamText`/`generateObject`
/`tool`) — there is **no** multi-step agent loop, tool-call orchestration, or
persisted message-thread/history. Yet every ingredient for a durable agent already
ships: `@lunora/workflow` (durable, replayable steps + `ctx.run`), `@lunora/server`
schema/db (thread + message tables), `@lunora/ai` (LLM + `tool`), and the vectors
path (memory/RAG, plan 111). Lunora hands users the pieces but no assembled
primitive. Whether to build a bespoke primitive vs. lean on `@lunora/workflow` +
docs is a maintainer strategy call — hence a spike.

## Current state

`packages/ai/src/` contains only `create-ai.ts`, `index.ts`, `types.ts`.
`index.ts:8` re-exports `embed, embedMany, generateObject, generateText,
streamObject, streamText, tool` from the AI SDK — raw primitives, no loop.

The durable machinery to reuse (`@lunora/workflow`,
`packages/workflow/src/index.ts`):
```ts
export { defineStep, isStepDefinition } from "./define-step";
export { defineWorkflow, … } from "./define-workflow";
export { branch, MAX_BRANCHES } from "./fan-out";   // child-DO fan-out (plans 076)
export { createWorkflowContext } from "./create-workflow-context";   // ctx.run durable steps
```
`@lunora/workflow` provides durable replayable steps over Cloudflare Workflows
(`ctx.run`, `defineStep`/`runStep`), fan-out with child-DO isolation + saga
(shipped, plans 075/076). Streaming to the client rides the existing WS
`kind:"stream"` transport (per prior analysis). Thread/message persistence maps
onto `@lunora/server` schema tables in the DO's SQLite.

Convex's shape (the parity target): a `defineAgent`-like primitive that persists a
message thread and drives a tool-loop (LLM → tool call → tool result → LLM …)
durably, with streaming and optional human-in-the-loop pauses.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Read ai index/create | `sed -n 1,40p packages/ai/src/index.ts` + `create-ai.ts` | current AI surface |
| Read workflow exports | `sed -n 1,40p packages/workflow/src/index.ts` | durable-step machinery |
| Read a step definition | `sed -n 1,60p packages/workflow/src/define-step.ts` | the durable-step contract |
| Typecheck (if prototyping) | `pnpm --filter "@lunora/ai" run lint:types` | exit 0 |

## Scope

**In scope (spike deliverables)**:
- A design document `plans/113-phase0-design.md` (create it) specifying: the
  `defineAgent({ model, tools, thread })` API; how the tool-loop runs as durable
  workflow steps (replay-safe — an LLM call and each tool call is a durable step
  so a mid-loop failure resumes without re-calling completed steps/tools); the
  thread/message schema (tables in the DO); how deltas stream to the client over
  the existing WS `kind:"stream"` transport; and how memory/RAG (plan 111) plugs
  in as a retrieval step/tool.
- A minimal proof-of-concept: a single-tool agent loop that persists messages and
  runs LLM→tool→LLM as durable steps (mock the LLM + tool if the sandbox can't
  reach a model, but exercise the loop + persistence + replay-safety logic).
- A numbered open-questions section covering the hard product/architecture
  decisions.

**Out of scope**:
- A shipped, production `defineAgent` with streaming, HITL, cost caps, multi-tool
  orchestration, and codegen wiring. The spike defines the API and proves the
  loop; the build is a later plan (or a decision NOT to build, deferring to
  workflow + docs).
- Client hooks / UI.
- Changing `@lunora/workflow` or `@lunora/ai` public surfaces (note needed
  changes as open questions instead).

## Git workflow

- Branch: `advisor/113-durable-agent-primitive-spike`
- Commit: `docs(ai): spike design + PoC for defineAgent durable tool-loop`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Map the reusable machinery

Read `@lunora/workflow`'s `define-step.ts`, `create-workflow-context.ts`, and the
`ctx.run` durable-call surface; `@lunora/ai`'s `tool()`/`generateText` surface;
and how the WS `kind:"stream"` transport delivers deltas (grep
`packages/do/src` + `packages/client/src` for `kind:"stream"` /
`use-stream`). Document exactly which existing primitive each part of the agent
loop maps onto (LLM call → durable step; tool call → durable step; message persist
→ DO table write; stream → WS stream frame).

**Verify**: the design doc's "machinery map" section names the reused primitive
for each loop component with file references.

### Step 2: Design the API + thread schema

Specify `defineAgent({ model, tools, thread, memory? })` and the runtime surface
(how an app invokes it — an action? a `ctx.agent.run(threadId, input)`?). Define
the thread/message schema (roles, tool-call records, timestamps) as
`defineSchema` tables. Decide replay-safety: each LLM call and tool execution is a
named durable step so a resumed run doesn't re-invoke a completed tool (idempotency
matters — a tool that charges a card must run once). Reference the workflow
duplicate-step-name lint (already shipped) as the guard.

**Verify**: the design doc has a concrete API + schema + a replay-safety argument.

### Step 3: Proof-of-concept

Build the smallest loop: persist a user message, call the (mocked) LLM, if it
returns a tool call run the (mocked) tool as a durable step, persist the tool
result, call the LLM again, persist the assistant reply. Prove that a simulated
mid-loop failure resumes without re-running the completed tool step. Streaming can
be stubbed (documented) if the full WS path is too large for the spike.

**Verify**: a unit test drives the loop with a mocked LLM/tool and asserts
(a) the message thread is persisted in order, and (b) on a simulated resume, the
already-completed tool step is not re-executed.

### Step 4: Open questions

Document the maintainer decisions: does this belong in `@lunora/ai` or a new
`@lunora/agent` package; how memory/RAG integrates (plan 111); human-in-the-loop
pause/resume (workflow `waitForEvent`?); cost/step caps; streaming transport
details; and — critically — whether a bespoke primitive is warranted vs.
documenting the workflow + ai composition (the "scale invisibly" tension: this IS
a user-facing primitive).

**Verify**: the design doc ends with a numbered open-questions section including
the build-vs-document decision.

## Test plan

- Spike-level: the PoC loop unit test (mocked LLM/tool) asserting persisted-thread
  ordering + resume-doesn't-re-run-completed-tool.
- No production suite required by this plan.

## Done criteria

- [ ] `plans/113-phase0-design.md` exists with: the machinery map (each loop part → reused primitive), a concrete `defineAgent` API + thread schema, a replay-safety/idempotency argument, and numbered open questions (incl. build-vs-document).
- [ ] A PoC demonstrates a persisted, durable single-tool loop with resume-safety (mocks allowed), with a passing unit test.
- [ ] The design explicitly addresses the "user-facing primitive vs. scale-invisibly" tension.
- [ ] `plans/README.md` status row updated.

## STOP conditions (spike — report, don't build the XL feature)

- The durable-step machinery can't guarantee tool-call idempotency across replays
  without changes to `@lunora/workflow` — STOP; document the required change as
  the follow-up's first task (a tool that runs twice on resume is a correctness
  cliff, e.g. double-charging).
- The design surface balloons (streaming + HITL + memory + cost caps each open
  large sub-designs) — that's expected for XL: STOP at the open questions and let
  the maintainer scope a phased build, rather than attempting it here.
- The maintainer's "scale invisibly" north star argues against a bespoke
  user-facing primitive — surface this tension prominently as the top open
  question; the honest spike outcome may be "document the composition, don't build
  the primitive."

## Maintenance notes

- Strongly related to plan 111 (RAG) — an agent's memory step consumes
  `ctx.rag.retrieve`. Sequence 111 before any 113 build.
- Reuses the shipped workflow fan-out/saga machinery (plans 075/076) and the
  duplicate-step-name lint — keep the agent loop's step naming compatible with
  those guards.
- If built, this is the flagship Convex-parity AI feature; the design doc is the
  artifact the maintainer uses to decide build-vs-document — make it decisive.
