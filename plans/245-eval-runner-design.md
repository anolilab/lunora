# Plan 245 Phase 0 — `lunora eval` runner + Studio Evals panel: design & prototype

> Design + prototype deliverable for plan 245 (SPIKE). The eval kit itself
> (`evaluate`, `llmScorer`/`keywordScorer`/`regexScorer`/`exactMatchScorer`/
> `containsScorer`, `agentHarness`, `recordEvaluation`) is unchanged by this
> work — `packages/testing/src/` has a zero-line diff. This doc defines the
> `*.eval.ts` discovery convention, the CI/`--threshold` exit-code contract,
> and the Studio panel's data source, and reports one real gap found while
> designing the panel.

**Baseline:** `36421ad58` (2026-07-31, drift-checked against `2d4f71511` per
plan — `git diff --stat 2d4f71511..HEAD -- packages/testing/src packages/cli/src
packages/studio/src/features` shows zero changes to `packages/testing/src` or
`packages/studio/src/features`; `packages/cli/src` changed in ways unrelated to
commands/eval, confirmed by reading the diff)

## 1. Current state (recap, verified)

- The kit is complete and untouched by this design:
  - `packages/testing/src/scorer.ts` — `evaluate(cases, produce, scorers)` →
    `EvalResult { average, items: EvalItemResult[] }`; five scorers.
  - `packages/testing/src/agent-harness.ts` — `agentHarness(agent, { script,
    functions? })` drives `runAgentLoop` against an in-memory `agents:*`
    runtime double and a `DurableStepJournal`. **No network, no Durable
    Object, no `wrangler dev`** — confirmed by reading the whole file.
    `agentHarness(...).run(...)` resolves in-process.
  - `packages/testing/src/evaluation-telemetry.ts` — `recordEvaluation({name,
    score, label?, span?})` returns `{ "gen_ai.evaluation.<name>.score":
    number, "gen_ai.evaluation.<name>.label"?: string }` and, when handed a
    `SpanHandle`, calls `span.setAttributes(...)` — i.e. it rides the SAME
    span as the generation it grades, it does not create a new one.
- No runner: `packages/cli/src/commands/` has no `eval` directory; `cli.ts`
  registers 30 commands, none named `eval`.
- No Studio surface: `packages/studio/src/features/` has no `evals/`; nothing
  under `packages/studio/src` references `gen_ai.evaluation`.
- `@lunora/cli`'s `package.json` does not depend on `@lunora/testing` today —
  adding the runner requires one new dependency edge.

## 2. Existing seams this reuses (do not reinvent)

- **Command shape**: `verify` (`packages/cli/src/commands/verify/{index,handler}.ts`)
  is the closest sibling — a read-only, offline-safe command with `--format
  pretty|json` (`util/output-format.ts`: `validateOutputFormat`,
  `loggerForFormat`, `isJsonFormat`, `printJson`) and a testable
  `run*Command(options): Promise<{code, ...}>` function wrapped by
  `defineHandler` (`util/command.ts`) for the cerebro `execute`. `lunora eval`
  copies this shape exactly.
- **File discovery**: `packages/codegen/src/discover-functions.ts`'s
  `listLunoraSourceFiles` — `readdirSync` + `lstatSync` (never `statSync`, so
  a directory symlink cycle isn't descended into), skipping `node_modules`/
  `_generated`. `discover-eval-files.ts` mirrors this walker verbatim, scoped
  to `*.eval.ts`.
- **Contrast — commands that DO need a live worker**: `seed` and `insights`
  both require `--url`/`--token` against a running Worker (`seed/index.ts`:
  "bulk-insert it via the worker's admin endpoint"; `insights/index.ts`:
  "Report... from a running Worker"). `lunora eval` is deliberately NOT this
  shape — see §4.

## 3. The `*.eval.ts` discovery convention

### Location: top-level `evals/`, not `lunora/**/*.eval.ts`

**Recommendation: a top-level `evals/` directory**, sibling to `lunora/`,
walked recursively (`evals/**/*.eval.ts`). Rejected alternative:
`lunora/**/*.eval.ts`.

Why not inside `lunora/`: `lunora/` is codegen's domain — every `.ts` file in
it (barring `schema.ts` at the root and anything under `_generated/`) is
walked by `listLunoraSourceFiles` and parsed as a candidate function module
(`discover-functions.ts`). An eval fixture is not a function module, but nothing
today teaches codegen to skip a `*.eval.ts` suffix, so dropping evals inside
`lunora/` risks a `.eval.ts` file being picked up as a broken/empty function
source the first time someone imports something codegen's static walk doesn't
expect, or at minimum adds a codegen-side carve-out for a concept codegen has
no reason to know about. `evals/` at the project root mirrors the existing
`__tests__/` convention (test-shaped code lives in its own top-level
directory, sibling to the source it exercises) and needs zero codegen changes.

### The eval module shape: a single default export, `{ name?, threshold?, run }`

```ts
// evals/support-triage.eval.ts
import { agentHarness, containsScorer, evaluate, finalTurn } from "@lunora/testing";
import { supportAgent } from "../lunora/agents";

export default {
    name: "support-triage", // optional — defaults to the filename minus `.eval.ts`
    threshold: 0.8, // optional — overrides `--threshold` for THIS eval only
    run: async () => {
        const harness = agentHarness(supportAgent, {
            script: [finalTurn("Your refund was issued.")],
        });

        return evaluate(
            [{ expected: "refund", input: "where's my refund?" }],
            async (input) => (await harness.run({ input, threadKey: input })).text ?? "",
            [containsScorer("refund")],
        );
    },
};
```

- **Single default export** — the repo-wide rule ("never mix default + named
  exports; default is fine only as the sole export", `CLAUDE.md`) makes this
  the only compliant shape that also carries per-eval metadata (`name`,
  `threshold`) alongside the executable body. A bare `export default async ()
  => EvalResult` (no metadata) was considered and rejected: it can't carry a
  per-eval threshold without a second named export, which the mixed-export
  rule forbids.
- **`run` is the ENTIRE eval body** — the runner does not call `evaluate`
  itself, does not construct scorers, does not touch `agentHarness`. The file
  imports what it needs from `@lunora/testing` and returns whatever
  `EvalResult` its own call to `evaluate(...)` produces. This is what makes
  "the kit is the product, the runner is glue" literal rather than aspirational:
  the runner's contract with a `*.eval.ts` file is exactly `() =>
  Promise<EvalResult> | EvalResult`, and `EvalResult` is the kit's own
  existing exported type — nothing new is added to `@lunora/testing`.
- **No `defineEval` helper (yet)** — the codebase's `define*` convention
  (`defineSchema`, `defineAgent`, `defineWorkflow`, …) would suggest a
  `defineEval` identity-typed helper in `@lunora/testing` for authoring DX
  (autocomplete, inline type errors on `run`'s return type). This is
  deliberately **not** added in this spike: the prototype's `evals/*.eval.ts`
  file structurally satisfies `EvalModule` (a type-only interface living in
  `@lunora/cli`, not in the kit) with zero coupling back into
  `packages/testing/src`, which is the strongest form of "reuses the kit
  UNCHANGED" this design could produce. If the shape holds up, promoting it to
  a real `defineEval` in `@lunora/testing` is a one-file, additive follow-up —
  flagged as an open question in §6, not decided here.

### Discovery mechanics (prototype)

`packages/cli/src/commands/eval/discover-eval-files.ts` — `readdirSync` +
`lstatSync` recursive walk under `--dir` (default `evals/`), collecting files
whose name ends in `.eval.ts`, skipping `node_modules`/`_generated`/`dist`/
`.git`, sorted for a deterministic run order. Absence of the directory is not
an error (mirrors `verify`'s "no tsconfig.json → warning, not error"): `lunora
eval` prints an info line and exits 0.

## 4. The CI contract: `--threshold`, exit codes, `--format json`

Mirrors `verify` exactly:

- `lunora eval` — runs every discovered eval, prints a table (`NAME  SCORE
  THRESHOLD  STATUS`), exits **0** if every eval ran without throwing (no
  threshold set → report-only; this is the "just show me the scores" mode).
- `lunora eval --threshold 0.8` — a **global** gate: every eval's `.average`
  must be `>= 0.8`, unless the eval's own `threshold` export overrides it
  (per-eval wins). Exits **1** if any eval falls below its effective
  threshold, or if any eval file throws while loading or running (a crash is
  always a failure, independent of thresholds).
- `--format json` — mirrors `verify`'s contract bit-for-bit: every
  human/progress line moves to stderr (`loggerForFormat`), stdout carries one
  JSON document (`printJson`) shaped `{ code, evals: [{ name, path, average?,
  threshold?, passed, error?, items? }] }`. Machine-readable, pipeable to
  `jq`, and the shape a CI step greps for a specific eval's score without
  re-running anything.
- **No per-eval exit code** — one process, one exit code, exactly like every
  other Lunora CLI command. A per-eval breakdown lives in the printed table /
  JSON body, not in the exit code's bits.
- Threshold granularity is **global by default, per-eval override** — not
  "global XOR per-eval." An app with nine settled evals and one new,
  known-noisy one sets `--threshold 0.85` globally and `threshold: 0.5` on the
  noisy file, rather than choosing one mode for the whole run.

## 5. Does the runner need a live worker? No — harness-only, and that is load-bearing

`agentHarness` (§1) is a pure in-memory double: a scripted `AgentGenerate`,
an in-memory `agents:*` runtime, a `DurableStepJournal` mimicking Workflows'
`step.do` memoization. `evaluate`'s `produce` callback is caller-supplied —
nothing in the kit reaches for `fetch`, a Durable Object stub, or a Worker
binding. Verified by reading `agent-harness.ts` and `scorer.ts` in full: **zero**
references to `fetch`, `WebSocket`, or any binding type.

This means `lunora eval` runs entirely in the CLI's own Node process — no
`wrangler dev`, no `lunora dev` running in another terminal, no `--url`/
`--token` like `seed`/`insights` need. That is a real, load-bearing property
for the CI story: a GitHub Actions step can run `pnpm --filter <app> exec
lunora eval --threshold 0.8` with no Worker to stand up first, no port to
wait on, no `wrangler dev` flake. This is the harness-only path the plan
asked to confirm or refute — **confirmed harness-only**, no live worker
required, and the design leans on that: nothing in §3–4 assumes a URL/token
option exists.

(An eval whose `produce` calls `ctx.ai`/a real model provider still needs
network egress and an API key — that is a property of the eval author's own
`run()` body, identical to any Vitest test that happens to hit a real API. It
is not something the runner arranges or gates.)

### An implementation gap this spike surfaces (not a STOP, but real)

The prototype's discovery step (`discoverEvalFiles`) finds `*.eval.ts` files;
running them requires actually **executing** TypeScript source, not just
parsing it (unlike codegen, which only ever statically walks `lunora/*.ts`
with `ts-morph` — see `discover-functions.ts` — and never runs user code).
The prototype does a plain `await import(pathToFileURL(file).href)`. Under
Vitest (this is how the CLI's own test suite exercises the fixture — see §7)
this works transparently: Vitest's module runner transforms any `.ts` it
resolves, including one reached via a dynamic `import()` at runtime, not only
statically-imported test files. Under the **compiled** `lunora` binary running
on plain Node, it works only on Node's built-in TypeScript type-stripping,
which is opt-in (`--experimental-strip-types`) on the `^22.15.0` floor this
repo's `engines` field allows and only unflagged by default starting Node
23.6 — so on a real `^22.15.0` install, importing a `.ts` eval file from the
shipped binary throws `ERR_UNKNOWN_FILE_EXTENSION` today. This is flagged as
an open question in §6, not solved here — the prototype's own test runs under
Vitest specifically to sidestep it and prove the discovery/threshold/aggregate
logic, which is this step's actual deliverable.

## 6. Studio Evals panel: data source, and a gap the panel design surfaces

### Where `gen_ai.evaluation.*` actually lives

`recordEvaluation` attaches its attributes to whatever `SpanHandle` the caller
hands it — the same post-hoc handle a `ctx.trace(name, (trace, span) => …)`
body receives (`evaluation-telemetry.ts:11-16`). That span is folded into the
shard's trace ring and surfaced today by the existing `__lunora_admin__:getTraces`
RPC (`packages/studio/src/lib/admin.ts:1014-1083`, consumed by
`TracesPanel`, `packages/studio/src/features/traces/traces-panel.tsx`) — a
`TraceSummary.spans[]` entry's `attributes` is exactly where a
`gen_ai.evaluation.<name>.score` key would show up. **No new RPC is needed for
a v1 panel** — `getTraces` already returns the data.

### The gap: that store is a live, bounded, in-memory ring — not history

Both `admin.ts`'s own doc comments are explicit about this, independently, for
the two candidate stores:

- `TraceSummary` (`admin.ts:1045-1048`): "Sourced from the shard's bounded,
  in-memory span ring, so it resets on hibernation/restart... a 'recent traces
  on this instance' readout for local development, **NOT a durable trace
  store**."
- `MetricSeries` (`admin.ts:1095-1098`): same story for `ctx.metrics` — "A
  'recent metrics on this instance' readout for local development, **NOT a
  durable metric store**."

There IS a durable, historical, per-minute-bucketed store already shipped —
`MetricHistoryPoint`/`getMetricHistory` (`admin.ts:1140-1159`, "persisted in
the shard's SQLite so it survives hibernation... ready to chart as a trend
line"). But it durably tracks `ctx.metrics.*` series (counter/gauge/
histogram), not trace-span attributes — and `recordEvaluation` today only
ever emits span attributes, never a metric. So the plan's ask ("groups by eval
name + score over time") runs into a real seam mismatch: the durable,
time-bucketed store exists, but eval scores don't flow into it; the store eval
scores DO flow into (trace spans) has no durable history.

**This is the STOP-shaped condition the plan called out** ("the
`gen_ai.evaluation.*` spans aren't queryable from the studio trace store the
way the panel needs") — but it resolves to a **documented gap + a v1 that
works within it**, not a hard stop, because `getTraces` genuinely does return
the data for a live/recent view; it just can't back a trend chart.

### Recommended v1 panel (design-only in this spike, not built — see §7): live, not historical

Model on `TracesPanel` directly (same admin query hook, same shard-scoped
live-push pattern):

- **Query**: `useAdminQuery(ADMIN_FUNCTIONS.getTraces, {}, { live: true,
  shardKey })` — identical call to what `TracesPanel` already makes.
- **Extraction**: client-side, over the returned `TraceSummary[]`. For each
  span in each trace, scan `attributes` for keys matching
  `/^gen_ai\.evaluation\.([^.]+)\.score$/`; the capture group is the eval
  name, the value the score; a sibling `.label` key (same name) is optional
  metadata. This is a pure function, exactly like `TracesPanel`'s existing
  `filterTraces`/`spanBar` helpers in `trace-geometry.ts` — same file-shape
  precedent.
- **Grouping/layout**: group extracted `(name, score, traceId, spanName,
  startTs)` rows by eval `name` into a card per eval — most-recent score,
  a small run count, a "min/mean/max over what's currently in the ring"
  summary (NOT a trend line — the ring doesn't support one), and a list of
  recent runs each linking to its trace (reusing the existing trace-id
  hand-off `lib/trace-handoff.ts` the Traces panel's exemplar links already
  use, so "open in Traces" is a real, already-built primitive, not new work).
  Same `EmptyState` message pattern as `TracesPanel` for the zero-evals-seen
  case.
- **Explicit framing in the UI**: reuse `TracesPanel`'s own caveat text
  verbatim in spirit — "recent scores on this instance, not a durable
  history" — so the panel doesn't imply a trend guarantee the data can't back.

### Follow-up (not this spike): durable trend requires a second emission

If a durable "score over time" chart is wanted, `recordEvaluation` would need
an ADDITIVE second path — emit through `ctx.metrics.gauge` (or a histogram)
alongside (not instead of) the span attributes, so `getMetricHistory`'s
already-durable per-minute buckets carry eval scores too and the panel can
build on `metrics-aggregate.ts`/`sparkline.tsx` (the existing trend-chart
building blocks in `packages/studio/src/features/reports/`) instead of
inventing one. This is exactly the kind of "changing the harness API" the
plan's SCOPE excludes for this spike (`recordEvaluation`'s signature/behavior
would need to grow), so it is recorded here as the concrete next step, not
attempted.

## 7. What actually ships in this spike

- This design doc.
- A working CLI prototype: `packages/cli/src/commands/eval/` (`index.ts`,
  `handler.ts`, `discover-eval-files.ts`, `types.ts`), registered in
  `cli.ts`, `@lunora/testing` added as a real dependency of `@lunora/cli`.
  `runEvalCommand` is directly unit-testable (mirrors `runVerifyCommand`).
- A CLI test (`packages/cli/__tests__/commands/eval.test.ts`) that runs a real
  fixture `evals/*.eval.ts` file (using actual `@lunora/testing` exports:
  `evaluate`, `containsScorer`) through `runEvalCommand`, asserting both the
  aggregate table/JSON output and that a below-threshold run exits non-zero.
- The Studio Evals panel is **design-only** in this spike (§6) — not
  prototyped as code. Rationale: the panel's honest v1 shape depends on the
  gap analysis in §6, which is itself the deliverable STEP 3 asked for
  ("otherwise the design doc details the data query + layout"); building a
  panel against the wrong data-source assumption (a trend chart the ring
  can't support) would need to be redone once the gap was found, so the spike
  stops at the design once the gap surfaced, per STEP 3's own stated
  fallback.

## 8. Open questions (STEP 4)

1. **`defineEval` helper** — promote the `{ name?, threshold?, run }` shape
   into a real `defineEval` export in `@lunora/testing` for authoring DX
   (return-type inference on `run`, discoverable via the package's own
   autocomplete)? This spike deliberately kept `@lunora/testing` at a
   zero-line diff; a follow-up plan can add it additively once the shape has
   seen real use.
2. **Threshold granularity** — resolved in §4 (global default, per-eval
   override) — flagged here because it's a public CLI contract, worth a second
   look before it ships (a `--threshold-mode strict|any` a la "all must pass"
   vs "aggregate average must pass" was considered and rejected as premature —
   the per-file `threshold` override already covers the "this one eval is
   noisier" case without a second flag).
3. **Live worker** — resolved in §5: no, harness-only. The remaining open
   question is narrower — the TS-execution mechanism for the compiled binary
   (§5's gap): Node `--experimental-strip-types` re-exec vs. an `esbuild`
   transform-then-`import()` (would promote `esbuild` from `@lunora/cli`'s
   existing devDependency to a real one — no other `@lunora/*` package ships
   it as a runtime dep today, confirmed by grep) vs. requiring the app's own
   `vitest`/`tsx`/`jiti` be present and shelling out to it. Recommend the
   `esbuild`-transform path (self-contained, no assumption about what the
   consuming app has installed) as the next step's first thing to prototype.
4. **Panel: live-tail vs. historical** — resolved in §6: live/recent only for
   v1 (matches what `getTraces` can actually back); a durable trend view is a
   distinct follow-up gated on also emitting through `ctx.metrics` (§6's
   "Follow-up" — not this spike, not decided here beyond "additive, don't
   change `recordEvaluation`'s existing signature, only extend it").
5. **`evals/` vs. per-package location for a monorepo app** — this design
   assumes one `evals/` per Lunora project root. An app with multiple
   `apps/*` each embedding Lunora would run `lunora eval` per-app, same as
   every other per-app CLI command (`verify`, `deploy`, …) — not a special
   case, but worth confirming against a real multi-app repo before this ships.
