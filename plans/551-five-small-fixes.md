# Plan 551 — Five small fixes: advisor duplicate index, CLI eval average, Nuxt `@/` alias, metric-buffer capacity, agent OTLP rejections

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):**
> `git diff --stat 4a7c48bfd..HEAD -- packages/advisor/src/lints/static/duplicate-index.ts packages/cli/src/commands/eval/handler.ts packages/nuxt/src/resolve-tilde-path.ts packages/observability/src/metric-buffer.ts packages/observability/src/log-buffer.ts packages/agent/src/telemetry/otlp.ts`
> must print nothing. Then confirm each excerpt in §1 matches. Any mismatch is a STOP for that item only:
> skip it, say so, continue with the others.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO
**Priority / effort / risk:** P3 / S each / LOW. **Category:** bug. **Depends on:** none.
One commit per item (five commits), each with its own test that fails without its fix.

## 0. Headline finding

Five independent, small defects, each with a one-place fix.

## 1. Current state (audit)

**A. `packages/advisor/src/lints/static/duplicate-index.ts:49-62`** — the cover search:

```ts
const cover = secondary.find((other) => {
    if (other === candidate) {
        return false;
    }

    if (!isLeadingPrefix(candidate.fields, other.fields)) {
        return false;
    }

    const sameLength = candidate.fields.length === other.fields.length;

    return sameLength ? candidate.name > other.name : true;
});
```

Candidates skip `unique === true` (lines 43-46), but a UNIQUE index can be the cover. With a non-unique
`a` and a unique `b` over the same columns, `"a" > "b"` is false, so `a` is never reported although
`b` covers it. Test file: `packages/advisor/__tests__/static-lints.test.ts`, `describe("duplicate_index")`
(line 38): `defineSchema({ posts: defineTable({…}).index(…) })`, `duplicateIndex.run({ schema: fromServerSchema(schema) })`.

**B. `packages/cli/src/commands/eval/handler.ts:220-228`** — in `runOneEval`:

```ts
const result = await evalModule.run();
const passed = effectiveThreshold === undefined || result.average >= effectiveThreshold;

return { name, passed, path: filePath, result, threshold: effectiveThreshold };
```

and `:270` `const score = outcome.result === undefined ? "—" : outcome.result.average.toFixed(3);`.
A `run()` from an arbitrary user file that resolves without a finite `average` passes (no threshold) or
fails silently (`NaN >= x` is false), and an `undefined` average crashes the table on `.toFixed`. The
file already validates the untrusted `threshold` export at runtime (lines 205-215, comment: "a runtime
check is the point here"). Tests: `packages/cli/__tests__/commands/eval.test.ts`, e.g. "a crashed eval
always fails the run" (line 153) using fixture dir `packages/cli/__tests__/fixtures/eval-crash-sample/evals/broken.eval.ts`
(`export default { name: "broken", run: async () => { throw new Error("boom"); } }`) and
`runEvalCommand({ cwd, logger })`.

**C. `packages/nuxt/src/resolve-tilde-path.ts:16-30`** — expands `~~/` (rootDir), `~/` (srcDir) and
relative paths; Nuxt's equally standard `@@/` (rootDir) and `@/` (srcDir) aliases pass through
unexpanded, and Nitro then resolves them against its own `server/` dir. A scoped package always has a
name after `@` (`@scope/pkg`), so a `@/` or `@@/` prefix is unambiguous. Test:
`packages/nuxt/__tests__/resolve-tilde-path.test.ts`.

**D. `packages/observability/src/metric-buffer.ts:97-99`**:

```ts
public constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity > 0 ? Math.trunc(capacity) : DEFAULT_CAPACITY;
}
```

`DEFAULT_CAPACITY` here is 256 (line 27). `0.5` passes `> 0` and truncates to 0 (every series
evicted); `Infinity` passes and removes the bound. `packages/observability/src/log-buffer.ts:58` has the
fix already: `const normalizeCapacity = (capacity: number): number => (Number.isFinite(capacity) && capacity >= 1 ? Math.trunc(capacity) : DEFAULT_CAPACITY);`
(log's `DEFAULT_CAPACITY` is 500), exported at `:141` and used by `span-buffer.ts:108`. Test:
`packages/observability/__tests__/metric-buffer.test.ts`.

**E. `packages/agent/src/telemetry/otlp.ts:199-207`** inside `flush()`:

```ts
const sent = fetch(tracesUrl, {
    body: JSON.stringify(wrapResourceSpans(spans, "@lunora/agent", serviceName)),
    headers: mergedHeaders,
    method: "POST",
}).catch(() => {
    // Network error / non-OK — intentionally ignored.
});

waitUntil?.(sent);
```

A non-OK response (401 wrong token, 404 wrong path, 422 rejected body) is indistinguishable from
success. The runtime's sink reports it: `packages/runtime/src/otlp-export.ts:450-482`
(`reportOtlpRejection(url, status)`: a rate-limited `console.error` naming only the status and the
endpoint HOST, never the body or path). `@lunora/agent` must not import `@lunora/runtime` for this.
Test: `packages/agent/__tests__/telemetry/otlp.test.ts`.

## 4. Design decisions

- A: skip the name tie-break when the cover is unique and the candidate is not:
  `return sameLength ? other.unique === true || candidate.name > other.name : true;` (candidates are
  already non-unique at this point).
- B: after `run()`, if `typeof result?.average !== "number" || !Number.isFinite(result.average)`, return
  `{ error: "run() must resolve to an EvalResult with a finite \`average\`", name, passed: false, path: filePath, threshold: effectiveThreshold }`(no`result`, so the table shows "—" and `ERROR: …`).
- C: `@@/` → `join(rootDirectory, …)`, `@/` → `join(sourceDirectory, …)`, checked BEFORE the `~` cases
  is irrelevant (disjoint prefixes); update the docblock to name both alias families.
- D: give `normalizeCapacity` an optional fallback: `(capacity: number, fallback: number = DEFAULT_CAPACITY)`;
  `MetricBuffer` calls `normalizeCapacity(capacity, DEFAULT_CAPACITY)` with ITS 256 default (import
  `normalizeCapacity` from `./log-buffer`; keep metric's own `DEFAULT_CAPACITY`).
- E: report locally, once per rejection streak: a closure flag `rejecting`; on a resolved response with
  `!response.ok` and `!rejecting` → set it and `console.error` one line with the status and
  `new URL(tracesUrl).host` (guard the URL parse); on an ok response → clear it. Network errors stay
  silent as today. Single-line `// eslint-disable-next-line no-console -- <reason>` (the runtime file
  does the same). No throw, no new dependency.

## 5. Workstream — steps

**Commands** (per package `<pkg>` ∈ advisor, cli, nuxt, observability, agent):

| Purpose             | Command                                                                                                   | Expected |
| ------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| Install             | `pnpm install`                                                                                            | exit 0   |
| Build deps          | `pnpm --filter "@lunora/<pkg>..." run build` (cli's closure is large; build it last)                      | exit 0   |
| Tests               | `pnpm --filter "@lunora/<pkg>" exec vitest run <test file>` then `pnpm --filter "@lunora/<pkg>" run test` | all pass |
| Types               | `pnpm --filter "@lunora/<pkg>" run lint:types`                                                            | exit 0   |
| Format              | `pnpm exec oxfmt <changed files>`                                                                         | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/<pkg>" run lint:eslint`                                                           | exit 0   |

**Scope.** In scope: the six source files in the drift check; the five test files named in §1; one new
fixture dir `packages/cli/__tests__/fixtures/eval-nan-average-sample/evals/` (create, one or two
`*.eval.ts` files modelled on `broken.eval.ts`). Out of scope: everything else, notably
`packages/runtime/src/otlp-export.ts` and the agent's other telemetry bridges.

**For each item A-E, in order:** (1) write the failing test; (2) run the one test file — it must fail;
(3) apply the §4 fix; (4) run it — passes; (5) commit that item's files by path; (6) red check:
`git diff HEAD~1..HEAD -- <the item's source file(s)> | git apply -R`, run the test file, confirm the new
test fails, `git checkout -- <source file(s)>`, `git status --short` clean; (7) package gates.

Tests to write:

- A: "flags a non-unique index exactly covered by a unique one, whatever their names": `.index("a", ["authorId"]).index("b", ["authorId"], { unique: true })`
  → one finding, `metadata.index === "a"`, `coveredBy.name === "b"`. Keep the existing exact-duplicate test green.
- B: fixture `nan.eval.ts` (`export default { name: "nan", run: async () => ({ average: Number.NaN, items: [] }) }`)
  and `missing.eval.ts` (`run: async () => ({ items: [] })`); test: `runEvalCommand({ cwd: <fixture dir parent>, logger })`
  → `code === 1`, both evals have an `error` mentioning `average`, and rendering does not throw.
- C: `resolveTildePath("@/lunora/server", rootDir, srcDir)` → `<srcDir>/lunora/server`;
  `"@@/lunora/server"` → `<rootDir>/lunora/server`; `"@lunora/app"` (a scoped package) unchanged.
- D: `new MetricBuffer(0.5)`, `new MetricBuffer(Number.POSITIVE_INFINITY)`, `new MetricBuffer(Number.NaN)`
  each keep at most 256 series and at least one (record 300 distinct series; assert `size` is 256), and
  `normalizeCapacity(0.5)` still falls back to 500 (log buffer unchanged).
- E: stub `fetch` with `vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })))` and
  `console.error` with `vi.spyOn(console, "error").mockImplementation(() => undefined)`; pass a
  `waitUntil` that collects the promise; emit spans and flush twice, `await Promise.all(collected)`; expect
  exactly one `console.error` call containing `401` and the endpoint host and NOT the path; then answer
  200, flush, then 401 again, flush → a second report (new streak). Restore stubs in `afterEach`
  (`vi.unstubAllGlobals()`, `mockRestore`). Find how existing tests in the file build `otlpTelemetry` and
  emit a span; copy that.

**Commits** (messages):

- `fix(advisor): report an index covered by a unique one regardless of names`
- `fix(cli): fail an eval whose run returns no finite average`
- `fix(nuxt): expand @/ and @@/ in the app entry alias`
- `fix(observability): bound the metric buffer like the log and span buffers`
- `fix(agent): report OTLP rejections once per streak`

Each body: one sentence of why, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                      |
| ----- | --------- | --------------------------------------------------------- |
| 0     | items A-E | each item's test red without its fix; five packages green |

## 8. STOP conditions

- An item's excerpt does not match → skip that item, report it, continue.
- E: if reporting needs an import from another `@lunora/*` package → skip E and say so.
- D: if any caller passes `normalizeCapacity` a second argument already or relies on its arity → STOP for D.
- Any pre-existing test in a touched package fails after the item's fix → STOP for that item.
- Two failed attempts at any one verification → STOP.

## 9. Open questions

None.

## Done criteria

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only in-scope files.
- [ ] Five commits (or fewer, each skip explained), each with a test that failed without its fix.
- [ ] advisor, cli, nuxt, observability, agent: `test`, `lint:types`, `lint:eslint` exit 0.
