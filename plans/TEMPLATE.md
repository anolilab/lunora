# Plan NNN — <one-line title: what changes and why>

<!--
Copy this file to `plans/NNN-slug.md` and fill it in. Drop sections that do not
apply — except **Platform parity**, which is mandatory for anything touching a
`ctx.*` surface or a provider binding (see the note in that section).

Completed plans are removed from `plans/` once shipped; the record lives in git
history and in the wave tables in `plans/README.md`. So write this for the person
who picks the work up mid-flight, not for posterity.
-->

**Baseline:** `<commit sha>` (<date>)
**Status:** TODO | IN PROGRESS | DONE | BLOCKED (<one-line reason>) | REJECTED

## 0. Headline finding

The one thing a reader must know before the detail. If the plan exists because
an audit turned something up, state the finding and its size here — not the
proposed fix.

## 1. Current state (audit)

What is true today, with file:line evidence. A claim without a reference is a
guess, and a plan built on guesses re-derives itself later.

## 2. Existing seams (do not reinvent)

The abstractions already in the codebase that this work should use. Listing them
is what stops a plan from building a second mechanism beside a working one.

## 3. The behavioural contract to preserve

What must not change, stated so a test could assert it. Wire formats, public
exports, ordering guarantees, golden fixtures.

## 4. Design decisions

Each with the alternative it was chosen over. A decision recorded without its
rejected alternative gets re-litigated.

## 5. Workstreams

Sized (S/M/L) and independently shippable where possible. Record status inline as
each lands (`**Done.**` plus what actually shipped, including anything that
turned out differently from the plan) — a workstream whose status lives only in
a PR description is invisible to whoever reads this file next.

## 6. Platform parity

**Mandatory when this plan adds or changes a `ctx.*` surface, a provider binding,
or a deploy/runtime capability.** State the mapping per target, or the explicit
non-support:

| Feature       | `cloudflare` | <other targets> | Notes                                        |
| ------------- | ------------ | --------------- | -------------------------------------------- |
| `ctx.<thing>` | native       | unsupported     | <what a host must provide, or why it cannot> |

Values are the `PlatformCapabilities` vocabulary: `native` | `emulated` |
`unsupported`. Codegen consumes this matrix — an `unsupported` feature is omitted
from the emitted types with a `platform_unsupported_feature` diagnostic, so a row
left unstated ships a surface that silently does nothing on that target.

Write the row even when the answer is "cloudflare only, no plan to port". The
point of the section is that the matrix cannot quietly fall behind the code; see
`packages/platform/docs/index.mdx` ("Adding to the matrix") for how to land the
change itself. Plan 114 introduced this requirement, and its AWS half is the second
target that makes it load-bearing.

If the plan touches no `ctx.*` surface or binding, say so in one line and move
on — an explicit "not applicable" is the signal that it was considered.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                |
| ----- | ---- | ----------------------------------------------------------------------------------- |
| 0     |      | <the check that proves it landed — a suite, a green gate, a byte-identical fixture> |

Every phase needs a gate that can fail. "Reviewed" is not a gate.

## 8. Risks & STOP conditions

- **STOP** if <condition that means the design is wrong> — re-scope, do not
  improvise around it.
- **Risk:** <what could go wrong> Mitigate: <how>
- **Perf watch:** <what to measure, with which `__bench__` suite> — name the
  benchmark, so "verify with the benches" is actionable rather than aspirational.

## 9. Open questions (answer during execution)

Numbered, so the answers can be recorded against them as the work proceeds.
