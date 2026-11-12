# Plan 593 — `runAdvisor` isolates a throwing lint instead of ending the run

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/advisor/src/index.ts packages/advisor/__tests__/dedupe-cache-keys.test.ts`
> If either file changed, compare the "Current state" excerpts against the live
> code; on a mismatch, STOP.

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** TODO
**Source:** row 55 of the 2026-11-11 audit (advisor lints).

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: bug (hardening)

## 0. Headline finding

`runAdvisor` calls every lint's `run` with no guard, so one lint that throws
(for example on a source shape its matcher did not expect) aborts the whole
advisor run. It runs inline in `lunora codegen` (dev watch and the deploy
preflight), so a single bug in one rule stops codegen for the user. No lint
throws today; this is hardening.

## 1. Current state (audit)

- `packages/advisor/src/index.ts:482-497`:

```ts
export const runAdvisor = (context: LintContext, options: RunAdvisorOptions = {}): Finding[] => {
    const lints = options.lints ?? ALL_LINTS;
    const findings: Finding[] = [];

    for (const lint of lints) {
        if (options.source !== undefined && lint.source !== options.source) {
            continue;
        }

        findings.push(...lint.run(context));
    }

    // Any two findings that share a `cacheKey` (...)
    return dedupeCacheKeys(findings);
};
```

- Callers: `packages/codegen/src/run-codegen.ts:608` (`...runAdvisor(advisorContext, { source: "static" })`)
  and the Studio's runtime lints. Both go through this one function, so the fix
  belongs here and nowhere else.
- `Finding` (`packages/advisor/src/types.ts:105-126`) has the fields
  `cacheKey, categories, description, detail, facing, level, metadata, name, remediation, title`.
  `Lint` (`types.ts:797-815`) has `categories, description, facing, level, name, remediation, run, source, title`.
- The deploy gate (`packages/cli/src/util/advisory-gate.ts:53`) blocks only on
  `level === "ERROR"`, and `--no-strict-advisories` turns the block off.
- `packages/advisor/__tests__/docs-lint-reference.test.ts` requires every row in
  `packages/advisor/docs/index.mdx` that looks like ``| `name` | `LEVEL` |`` to name a
  REGISTERED lint. So the new finding name must NOT get a lint-table row in that page.

## 2. Existing seams

- Test pattern: the `describe("runAdvisor cacheKey disambiguation")` block in
  `packages/advisor/__tests__/dedupe-cache-keys.test.ts:40-70` builds an inline
  `Lint` object and calls `runAdvisor({ schema: { tables: [] } }, { lints: [lint] })`. Copy it.

## 3. Behavioural contract to preserve

- Findings of lints that do not throw are unchanged and keep declaration order.
- `dedupeCacheKeys` still runs over the combined list.

## 4. Design decisions

- **The failure finding carries the throwing lint's own `level`.** Chosen over a
  fixed `WARN`: a crashed ERROR-level security lint must still block a strict
  deploy (today a crash also blocks it, by aborting codegen), while the rest of
  the run's findings are now reported. `--no-strict-advisories` is the escape
  hatch. A fixed WARN would let a deploy pass a security check that never ran.
- Finding name `advisor_lint_failed`, not registered as a lint (it is not a rule).

## 5. Steps

### Step 1: catch per lint

In `runAdvisor`, wrap `findings.push(...lint.run(context));` in `try { … } catch (error) { … }`.
In the catch, push exactly one finding:

```ts
findings.push({
    cacheKey: `advisor_lint_failed:${lint.name}`,
    categories: lint.categories,
    description: "An advisor lint threw while running, so its check did not run. This is a bug in the lint, not in your app.",
    detail: `The \`${lint.name}\` lint threw: ${error instanceof Error ? error.message : String(error)}. Its findings are missing from this run.`,
    facing: "INTERNAL",
    level: lint.level,
    metadata: { lint: lint.name },
    name: "advisor_lint_failed",
    remediation: "Report the error with the source shape that triggered it. Pass `--no-strict-advisories` to deploy past it in the meantime.",
    title: `Advisor lint \`${lint.name}\` failed`,
});
```

Add a short comment above the `try` saying why (one throwing rule must not end the
codegen run in dev watch and the deploy preflight; the finding keeps the lint's level
so a strict deploy still fails closed). Do not touch anything else in the file.

**Verify**: `pnpm --filter "@lunora/advisor" run lint:types` → exit 0.

### Step 2: tests

In `packages/advisor/__tests__/dedupe-cache-keys.test.ts`, add a new
`describe("runAdvisor lint isolation", …)` with two tests, modelled on the
existing inline-`Lint` test in the same file:

1. Two lints: the first `run: () => { throw new Error("boom"); }` with `level: "ERROR"`,
   `name: "throwing_lint"`; the second returns one finding (`finding("ok:1")`). Assert
   (`expect.assertions` set) that `runAdvisor(...)` does not throw, returns 2 findings,
   the first has `name: "advisor_lint_failed"`, `level: "ERROR"`,
   `cacheKey: "advisor_lint_failed:throwing_lint"`, `metadata: { lint: "throwing_lint" }`
   and a `detail` containing `boom`, and the second has `cacheKey: "ok:1"`.
2. A throwing lint with `level: "INFO"` produces a failure finding with `level: "INFO"`.

**Verify**: `pnpm --filter "@lunora/advisor" exec vitest run __tests__/dedupe-cache-keys.test.ts` → all pass.

### Step 3: red without the fix

Temporarily remove the `try`/`catch` (restore the original single line), re-run the
test file, confirm the two new tests FAIL, then restore your fix. Do not commit the
broken state.

**Verify**: the same test command → the 2 new tests fail with the fix removed, pass with it.

### Step 4: gates and commit

Run, all exit 0: `pnpm --filter "@lunora/advisor" run lint:eslint`,
`pnpm --filter "@lunora/advisor" run lint:types`, `pnpm --filter "@lunora/advisor" run test`.
Commit the two files: `fix(advisor): isolate a throwing lint in runAdvisor`.

## Commands you will need

| Purpose    | Command (from the worktree root)                  | Expected           |
| ---------- | ------------------------------------------------- | ------------------ |
| Install    | `pnpm install --frozen-lockfile`                  | exit 0             |
| Build deps | `pnpm --filter "@lunora/advisor..." run build`    | exit 0             |
| Types      | `pnpm --filter "@lunora/advisor" run lint:types`  | exit 0             |
| Lint       | `pnpm --filter "@lunora/advisor" run lint:eslint` | exit 0, 0 warnings |
| Tests      | `pnpm --filter "@lunora/advisor" run test`        | all pass           |

## Scope

In scope: `packages/advisor/src/index.ts` (the `runAdvisor` body only),
`packages/advisor/__tests__/dedupe-cache-keys.test.ts`.
Out of scope: `packages/advisor/docs/index.mdx` (a lint row there would fail
`docs-lint-reference.test.ts`), `packages/cli/**`, `packages/codegen/**`, every lint file.

## Done criteria

- [ ] advisor `lint:eslint`, `lint:types`, `test` exit 0
- [ ] the two new tests fail with the `try`/`catch` removed
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists exactly the two in-scope files
- [ ] `grep -n "advisor_lint_failed" packages/advisor/src/index.ts` → at least 2 matches

## STOP conditions

- `runAdvisor` no longer matches the excerpt.
- `api:check`-relevant change: if you find yourself exporting a new symbol, STOP (none is needed).
- `docs-lint-reference.test.ts` or `lint-registration.test.ts` fails after your change.
- A verification fails twice after a reasonable fix.

## 7. Phasing & ordering

One phase; gate: the advisor test suite including the two new tests, which fail without the fix.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding.

## Maintenance notes

- Rollout: no matcher changes, so no new findings in any app. A user only ever sees
  `advisor_lint_failed` when a lint has a bug.
- Reviewers: check the catch does not swallow the error text (it goes into `detail`).
