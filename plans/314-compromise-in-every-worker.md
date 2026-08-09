# Plan 314 — Stop shipping an English NLP library in every Worker

**Baseline:** `9f2974487` (2026-08-09)
**Status:** TODO
**Priority:** P2 · **Effort:** S–M · **Risk:** MED · **Category:** perf/deps

> **Executor instructions**: measure before and after with the tooling that
> already exists — `lunora build` reports the worker size and
> `<outDir>/bundle-meta.json` carries esbuild's `bytesInOutput` per module. A
> change here is only worth landing if the number moves; put it in the PR body.
>
> **Drift check (run first)**: confirm `@visulima/redact` still depends on
> `compromise` (`node -e` on its `package.json`) and that
> `packages/observability/src/request-log.ts` still imports it. If redact has
> dropped the dependency upstream, this plan is done — say so and close it.

## 0. Headline finding

Every Lunora Worker ships **`compromise`, an English natural-language-processing
library**, because `@visulima/redact` hard-depends on it (`"compromise":
"^14.15.1"`, verified in the installed package) and
`packages/observability/src/request-log.ts` imports redact for `redactArgs`.

`request-log.ts` is on the request path — `database-telemetry.ts` and
`context-telemetry.ts` both call `redactArgs` — so the dependency is reachable
from any app that logs, which is all of them.

It was surfaced during wave 20's worker-size work, which measured it at ~606 KiB
raw in the bundle, **larger than any first-party Lunora package**, against a
`templates/standalone` worker of 412.9 KiB gzipped / 1684.9 KiB raw. The
installed package on disk is 3.8 MB.

Nobody using Lunora asked for NLP. They asked for their logs not to leak secrets.

## 1. Current state (audit)

Establish these before choosing an approach — the size figure above is from
wave 20 and should be re-measured, not trusted:

- What `redactArgs` actually calls in redact, and whether that entry point is
  the one that pulls `compromise` in. Redact's rule-based redaction and its
  NLP-assisted detection are plausibly separate entry points; if so this is an
  import-specifier change, not a dependency removal.
- Whether the pull is at module scope or inside a function — a top-level import
  defeats tree-shaking regardless of whether the code path runs.
- What the bundler actually emits: `bytesInOutput` from `bundle-meta.json` is
  the authoritative number, not `du` on `node_modules`.
- Whether anything in Lunora depends on redact's NLP behaviour (detecting a
  name or address in free text) as opposed to its pattern rules (tokens, keys,
  emails). If nothing does, the NLP half is pure cost.

## 2. Existing seams (do not reinvent)

`lunora build` already reports worker size, wave 20 shipped the CI size budget
(`scripts/check-worker-size.js` + `worker-size.json`), and
`<outDir>/bundle-meta.json` already carries per-module byte counts. The
measurement half of this plan needs no new tooling.

## 3. The behavioural contract to preserve

- **Redaction must not get weaker.** Whatever is redacted today stays redacted.
  A smaller bundle that leaks a token into a log is a straight loss, and this
  code exists on the security path.
- Any change is **observable in a test**: pin the redaction behaviour first, so
  the before/after diff is provably a size change and not a behaviour change.

## 4. Approaches, in order of preference

1. **Use redact's rule-based path only**, if it is separable. Cheapest, no new
   dependency, no behaviour change if nothing relies on NLP detection.
2. **Lazy-load the NLP half** behind a dynamic import so it never enters the
   Worker bundle. Note the Workers runtime constraint: a dynamic import must
   still be statically analysable at build time, so verify the bundler actually
   splits it rather than inlining it.
3. **Replace `redactArgs`** with a small first-party pattern redactor. Last
   resort — it is new security-path code, and `CLAUDE.md` prefers a maintained
   library over hand-rolling. Only if 1 and 2 both fail.
4. **Upstream**: ask whether redact can make `compromise` optional. Slowest, but
   the only fix that helps every consumer; worth filing regardless of which of
   1–3 lands here.

## 5. Workstreams

| #   | Work                                                                                | Size |
| --- | ----------------------------------------------------------------------------------- | ---- |
| 1   | Characterisation tests pinning current redaction behaviour                          | S    |
| 2   | Measure: `bytesInOutput` for `compromise` in a `templates/standalone` build, before | S    |
| 3   | The change, per §4's order                                                          | S–M  |
| 4   | Re-measure and record both numbers in the PR body                                   | S    |
| 5   | An upstream issue on redact if `compromise` cannot be made optional locally         | S    |

## 6. Platform parity

**Not applicable** — no `ctx.*` surface, binding, or deploy capability changes.
Bundle contents only. Recorded explicitly per the repo convention.

## 7. Phasing & ordering

| Phase | Work  | Gate                                                                                                    |
| ----- | ----- | ------------------------------------------------------------------------------------------------------- |
| 0     | WS1–2 | Characterisation tests pass on unchanged code; a recorded baseline byte count                           |
| 1     | WS3   | Same tests pass; `compromise` absent from `bundle-meta.json`, or its `bytesInOutput` materially reduced |
| 2     | WS4–5 | Both numbers in the PR body; upstream issue filed or explicitly declined                                |

## 8. Risks & STOP conditions

- **STOP if redaction behaviour changes at all.** This is a security path; a
  size win is not worth a weaker redactor, and the characterisation tests exist
  to make that decision automatic rather than a judgement call.
- **STOP if the NLP path turns out to be load-bearing** for something Lunora
  documents. Then the finding is "we ship an NLP library on purpose", which is a
  legitimate answer — record it and close the plan.
- A dynamic import that the bundler inlines anyway is a silent no-op. The gate
  is the byte count, not the shape of the source.

## 9. Open questions (answer during execution)

- Is `redactArgs` the only redact entry point Lunora uses?
- Does anything outside `@lunora/observability` import redact?
- Is the Studio's log viewer relying on server-side redaction, or does it redact
  again client-side — i.e. is there a second copy of this cost in the browser
  bundle?
