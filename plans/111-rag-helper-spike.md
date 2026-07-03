# Plan 111: [Spike] First-class RAG helper coupling `ctx.ai.embed` + `ctx.vectors`

> **Executor instructions**: This is a DESIGN/SPIKE plan. The deliverable is a
> design document + a minimal prototype of the API — NOT a shipped, all-options
> package. Follow the steps, produce the artifacts, STOP at the open questions.
> Update `plans/README.md` when the spike is complete.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/ai packages/bindings/src/vectors`

## Status

- **Priority**: P2
- **Effort**: M (spike); package build is M+
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: direction (feature / spike)
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

RAG ("AI on my data") is the single most common AI backend pattern, and Lunora
already ships both halves — but only as a documented DIY recipe. `@lunora/ai`'s
`create-ai.ts` literally says _"Pair `embed` with `@lunora/bindings/vectors` for
RAG"_, and `@lunora/bindings/vectors` takes a caller-supplied `embed` function and
exposes a raw `query(indexName, {topK,…})`. So today the user hand-wires embed →
upsert → query → context-assembly on every RAG app. Both facades (`ctx.ai`,
`ctx.vectors`) are already codegen-wired onto ctx, so a helper that closes the
loop (`ctx.rag.{index,retrieve}`) is disproportionately cheap and is a headline
Convex-parity capability (`@convex-dev/rag`). Whether a bundled helper is the
right shape (vs. leaving it a recipe) is a product call — hence a spike.

## Current state

`packages/ai/src/create-ai.ts:15-22` documents the manual pairing:

```
 * … Pair `embed` with `@lunora/bindings/vectors` for RAG. …
```

`@lunora/ai` re-exports the AI SDK primitives (`embed`, `embedMany`,
`generateText`, `streamText`, `tool`, …) at `packages/ai/src/index.ts:8`, and
`ctx.ai.model(...)`/`ctx.ai.embeddingModel(...)` resolve a Workers AI id or any
AI SDK model.

`@lunora/bindings/vectors` (`packages/bindings/src/vectors/create-vectors.ts`):

- `toVector` (`:24-32`) calls a caller-supplied `input.embed(input.input)` to
  build a `VectorizeVector` for upsert.
- `query(indexName, input)` (`:82-90`) runs a raw Vectorize query with a `topK`
  ceiling (20 with values/full metadata, 100 otherwise).

So the primitives exist; what's missing is the glue: chunk → embed → upsert on the
write side, and query → embed → topK → assemble on the read side.

Package facts: `@lunora/ai` (Vercel AI SDK v6 + `workers-ai-provider`),
`@lunora/bindings/vectors` (thin `ctx.vectors` facade over Vectorize). Both are
codegen-wired onto ctx when used (`discover-feature-usage` PROBES include `ai` and
`vectors`).

## Commands you will need

| Purpose                                 | Command                                                         | Expected                         |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------- |
| Read create-ai                          | `sed -n 1,60p packages/ai/src/create-ai.ts`                     | the pairing note + model helpers |
| Read create-vectors                     | `sed -n 1,120p packages/bindings/src/vectors/create-vectors.ts` | upsert/query surface             |
| Typecheck (if prototyping in a package) | `pnpm --filter "@lunora/ai" run lint:types`                     | exit 0                           |

## Scope

**In scope (spike deliverables)**:

- A design document `plans/111-phase0-design.md` (create it) specifying the RAG
  helper API: where it lives (a new `@lunora/rag`? a `@lunora/ai/rag` subpath? a
  `defineRag(...)` in `lunora/`?), the shape (`ctx.rag.index(...)` /
  `ctx.rag.retrieve(...)`), the chunking strategy (built-in vs pluggable), the
  metadata schema, and where the embedding model is declared.
- A minimal prototype (in a scratch module or a subpath) proving the loop: given a
  document and an index, `index()` chunks+embeds+upserts, and `retrieve(query)`
  embeds+queries+returns ranked, context-assembled results — using the existing
  `ctx.vectors` + `ctx.ai.embed` primitives, no new binding.
- Open questions for a maintainer decision.

**Out of scope**:

- A production-grade package with every chunking option, reranking, hybrid
  search, etc. The spike defines the API and proves the loop.
- New Cloudflare bindings — the helper composes the two existing facades.
- Client-side hooks.

## Git workflow

- Branch: `advisor/111-rag-helper-spike`
- Commit: `docs(rag): spike design + prototype for ctx.rag over ai.embed + vectors`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Map the two primitives precisely

Read `create-ai.ts` (embed surface, model resolution) and
`create-vectors.ts` (upsert `toVector`, `query` ceilings, namespace/metadata
handling) in full. Document the exact function signatures the RAG helper will
compose, and the `topK` ceilings + metadata constraints it must respect.

**Verify**: the design doc lists the exact `embed` and `vectors.upsert/query`
signatures the helper wraps.

### Step 2: Design the API

Specify:

- **Placement**: recommend one of `@lunora/rag` (new package), `@lunora/ai/rag`
  (subpath), or a `defineRag(...)` declaration discovered by codegen (like
  `defineSchema`) that wires `ctx.rag`. Weigh against the "scale invisibly" north
  star and the existing ctx-facade pattern. Recommend one, with rationale.
- **Write side**: `index({ id, text, metadata? })` — chunking (default strategy +
  override hook), embed each chunk via `ctx.ai.embed`/`embeddingModel`, upsert via
  `ctx.vectors` with a metadata schema linking chunks → source.
- **Read side**: `retrieve(query, { topK?, filter? })` — embed the query, run
  `ctx.vectors.query` (respecting the ceilings), assemble ranked context (return
  shape: ranked chunks + assembled string + source refs).
- Where the embedding model is declared (per-call vs a `defineRag({ embeddingModel
})` declaration) so both sides use the same model.

**Verify**: the design doc has a concrete API surface with types.

### Step 3: Prototype the loop

Implement the smallest version (scratch module or subpath) that runs
index→retrieve end to end against the real `ctx.vectors` + `ctx.ai.embed`
primitives (mock the actual Vectorize/Workers AI calls if the sandbox can't reach
them, but exercise the composition logic). Confirm the chunk↔source metadata
round-trips and the assembled result is well-formed.

**Verify**: a unit test drives index→retrieve with mocked embed/vectors and
asserts the assembled result contains the expected chunks/refs.

### Step 4: Open questions

Document the maintainer decisions: package vs subpath vs `defineRag`; default
chunking; metadata schema ownership; whether retrieval should integrate with
`tool()` for agent use (ties to plan 113); reranking scope.

**Verify**: the design doc ends with a numbered open-questions section.

## Test plan

- Spike-level: a unit test of the composition logic (index→retrieve) with mocked
  `embed`/`vectors`, in whatever scratch/subpath location the prototype lives.
- No production suite required by this plan (the follow-up build adds it).

## Done criteria

- [ ] `plans/111-phase0-design.md` exists with: the two primitives' signatures, a concrete `ctx.rag`/`defineRag` API proposal with a recommended placement, and numbered open questions.
- [ ] A prototype demonstrates index→retrieve over the existing `ctx.ai.embed` + `ctx.vectors` primitives (with a passing composition unit test, mocks allowed).
- [ ] The design respects the existing `topK` ceilings + metadata constraints of `@lunora/bindings/vectors`.
- [ ] `plans/README.md` status row updated.

## STOP conditions (spike — report, don't over-build)

- The two primitives can't be composed without changing `@lunora/bindings/vectors`
  or `@lunora/ai` public surfaces — STOP and document what change each would need
  (that becomes the follow-up's scope + a maintainer decision).
- Chunking / metadata design opens a genuinely large product surface (multiple
  reasonable defaults with real tradeoffs) — that's the point of the spike: STOP
  at the open questions rather than picking arbitrarily.

## Maintenance notes

- This helper is adjacent to plan 113 (durable agent) — an agent's memory/RAG step
  would likely consume `ctx.rag.retrieve`. Design the retrieve return shape with
  that consumer in mind (note it in the design doc).
- Keep the helper a thin composition of the two existing facades; do not
  reimplement embedding or vector query.
