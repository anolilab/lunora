# Plan 395: [Spike] Design stream/observable subscription forms for the non-Dart SDK targets

> **Executor instructions**: This is a **design spike, not an implementation plan**.
> The deliverable is a design document — `plans/395-sdk-stream-forms-design.md` —
> plus zero source-code changes. Read-only on `packages/**` and `sdks/**`.
> If anything in the "STOP conditions" section occurs, stop and report.
> Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/codegen/src/sdk/`
> Large drift means the target layer moved — re-read before designing.

## Status

- **Priority**: P3
- **Effort**: M (the spike; the eventual implementation is L, per-language)
- **Risk**: LOW (spike produces a doc)
- **Depends on**: plans/388-codegen-dart-watch-collision.md (the reserved-name-list lesson it institutionalizes)
- **Category**: direction
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Live queries are the framework's headline capability. The Dart SDK target emits two subscription members per query — the callback `subscribeX` and a `Stream`-returning `watchX` — and its own doc calls the stream form "the reason this target exists at all": Flutter's `StreamBuilder` consumes it with no adapter and no lifecycle management. The other seven generated SDKs (go, java, kotlin, python, ruby, rust, swift) emit only the callback form, so binding a live query to a UI means hand-rolling the bridge to Kotlin `Flow`, Swift `AsyncSequence`, Rust `Stream`, Python `async for`, etc. — each a small, idiomatic adapter users will predictably write themselves. The target-conventions doc (`packages/codegen/src/sdk/target.ts:29-47`) declares that cross-target behavioural decisions must be conventions, "not preferences" — today Dart's second form is an undeclared asymmetry. This spike decides the convention and the per-language shapes before anyone implements.

## Current state

- `packages/codegen/src/sdk/targets/dart.ts:353-389` — `renderSubscribe` emits both forms; the docblock is the design rationale to generalize.
- `packages/codegen/src/sdk/target.ts:29-47` — the conventions list every target must follow; the stream-form decision belongs here.
- `packages/codegen/src/sdk/spec.ts:623-645` — `assertMethodsGeneratable` reserves member names; plan 388 adds `Watch${memberBase}` for Dart. Every new per-language member name must be reserved in the same change that emits it (this bug shipped once already).
- `sdks/{kotlin,swift,rust,python,go,java,ruby}/` — the hand-written transport runtimes; each already carries subscribe plumbing (commit `17129fa4b` added optimistic/offline machinery across all seven).
- `bash sdks/run-all.sh` / `bash sdks/generated-check.sh` — the conformance gates any eventual implementation must pass.

## Commands you will need

| Purpose                               | Command                                                                                                                     | Expected on success          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Locate per-language subscribe surface | `grep -rn "subscribe" sdks/kotlin/src/ sdks/swift/ sdks/rust/src/ --include="*.kt" --include="*.swift" --include="*.rs" -l` | files listing                |
| Confirm target emitters               | `grep -n "subscribe" packages/codegen/src/sdk/targets/*.ts`                                                                 | one callback form per target |

## Scope

**In scope** (deliverable):

- `plans/395-sdk-stream-forms-design.md` — the design doc (create).

**Out of scope**:

- ANY change under `packages/` or `sdks/` — this spike writes one markdown file.

## Git workflow

- Branch: `improve/wave22-codegen`
- Commit: `docs(codegen): design sdk stream subscription forms`

## Steps

### Step 1: Survey

For each of the seven targets, read the emitted subscribe member (`packages/codegen/src/sdk/targets/<lang>.ts`) and the transport runtime's subscribe primitive (`sdks/<lang>/`). Record per language: the idiomatic stream type (Kotlin `Flow` via `callbackFlow`, Swift `AsyncThrowingStream`, Rust `futures::Stream`, Python `AsyncIterator`, Go `iter.Seq2`/channel, Java `Flow.Publisher`, Ruby `Enumerator`), what the runtime already exposes, and the cancellation story (does unsubscribe fire on stream drop?).

### Step 2: The design doc

Write `plans/395-sdk-stream-forms-design.md` containing:

1. **The convention**, phrased for `target.ts:29-47`: every target SHOULD emit a stream form per query where the language has a canonical async-stream type; the member name prefix per language; the reserved-name-list entries each adds (`Watch`/`watch_`/etc.) — extending `assertMethodsGeneratable` in the same change is mandatory (cite plan 388).
2. **Per-language table**: stream type, member name, cancellation semantics, error-delivery semantics (terminate vs. side-channel — Dart terminates the stream; decide and state it per language).
3. **Ordering**: Kotlin `Flow` and Swift `AsyncSequence` first (their UI layers consume them directly), with a one-paragraph justification; Ruby/Go last or "not worth it" with reasoning.
4. **Open questions** for the maintainer: buffering/backpressure policy, whether the callback form stays (recommend: yes, matching Dart), Java's lack of a blessed pre-Loom type.
5. **Effort per target** (S/M) and the conformance-suite additions (`sdks/run-all.sh` cases) each needs.

### Step 3: File it

Nothing else. Do not start an implementation.

## Test plan

None — documentation deliverable.

## Done criteria

- [ ] `plans/395-sdk-stream-forms-design.md` exists with the five sections above
- [ ] `git status` shows exactly one new file (plus this plan's status untouched)
- [ ] Every per-language claim in the doc cites a real file (`sdks/<lang>/...` or `targets/<lang>.ts`)

## STOP conditions

- A target's transport runtime turns out to lack a working subscribe primitive (contradicts the premise — report which).
- You find an existing design doc for this (grep `plans/` and `docs/` for "stream" + "sdk") — reconcile instead of duplicating.

## Maintenance notes

- The design doc is input to a future implementation wave; each language lands separately, each growing the reserved-name list + conformance suite in its own PR.
