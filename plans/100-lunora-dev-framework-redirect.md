# Plan 100: `lunora dev` detects a Vite/framework project and prints a redirect hint

> **Executor instructions**: Follow step by step; run each verify. STOP
> conditions halt you. Update `plans/README.md` when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/cli/src/commands/dev packages/config/src/detect-framework.ts`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

In a Vite/meta-framework project (react-router, tanstack-start, nuxt, …) the
`@lunora/vite` plugin runs the worker *inside* Vite, so the template's dev script
is `vite`/`nuxt dev`, not `lunora dev`. A user who types `lunora dev` out of
habit gets a bare `wrangler dev` of the worker — no frontend, no HMR, possibly a
non-standalone entry — a confusing "why is my app blank" with no hint. `lunora
dev` is *intentionally* wrangler-only (a project may not use Vite), so the fix is
a one-line redirect **hint**, not a behavior change: detect a framework and tell
the user to run their framework dev script instead.

## Current state

`packages/cli/src/commands/dev/handler.ts:145-174` — `planDevCommand` always
plans `wrangler dev` and never consults `detectFramework`:

```ts
/**
 * Plan `lunora dev`: it runs the worker via `wrangler dev` and nothing else …
 * Vite is intentionally NOT spawned — a project may not use Vite, and when it
 * does, the `@lunora/vite` plugin already runs the worker inside Vite …
 */
const planDevCommand = (options: DevCommandOptions): DevCommandPlan => {
    const cwd = options.cwd ?? process.cwd();
    const workerPort = options.workerPort ?? DEFAULT_WORKER_PORT;
    const manager = detectPackageManager(cwd);
    const remote = resolveRemotePlan(options, cwd);
    // …
    const exec = execArgsFor(manager, "wrangler", ["dev", "--port", String(workerPort), "--var", "WORKER_ENV:development", ...remote.args]);
    return { codegenEnabled: …, remote: …, studioEnabled: …, workerOrigin: …, workerPort, wrangler: { args: exec.args, command: exec.command, cwd, tag: "wrangler" } };
};
```

The detector is available (`packages/config/src/detect-framework.ts:79,96`):
```ts
const detectFramework = (root: string): FrameworkDetection => { … };
export { detectFramework };
```
It returns `{ framework, class }` where `framework: "none"` / class `"C"` means
standalone (no framework). Read the file's top comment (lines ~5-48) for the full
`FrameworkClass` semantics and the exact `FrameworkDetection` shape before using
it. `detectFramework` is re-exported from `@lunora/config` (grep for how the CLI
already imports config helpers — e.g. `detectPackageManager` sibling utils).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm --filter "@lunora/cli" run lint:types` | exit 0 |
| Tests | `pnpm --filter "@lunora/cli" run test` | all pass |
| Find dev tests | `ls packages/cli/__tests__/commands/ \| grep dev` | a `dev*.test.ts` |

## Scope

**In scope**:
- `packages/cli/src/commands/dev/handler.ts` — add framework detection + a
  redirect-hint log; keep the wrangler plan unchanged (still runs).
- The dev command's test file (add a case).

**Out of scope**:
- Changing `planDevCommand` to actually spawn Vite / block wrangler. The command
  must still run `wrangler dev` (by design). This plan only adds a printed hint.
- `detect-framework.ts` itself.

## Git workflow

- Branch: `advisor/100-lunora-dev-framework-redirect`
- Commit: `dx(cli): hint the framework dev script when lunora dev runs in a Vite project` — **NOTE**: the commitlint enum may reject `dx`; if the commit hook fails, use `feat(cli): …` or `fix(cli): …` instead (see the Wave 3 note in `plans/README.md`).
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Detect the framework in the dev handler

`planDevCommand` is pure/synchronous and unit-tested — keep it that way. Two
options; prefer (a):

(a) Call `detectFramework(cwd)` inside `planDevCommand`, and when it returns a
non-standalone framework (class `A`/`B`, i.e. `framework !== "none"`), add a
`hint` field to the returned `DevCommandPlan` (e.g. `frameworkHint?: string`).
The *runner* (the async caller that consumes the plan and logs) prints the hint
before/around spawning wrangler. This keeps `planDevCommand` pure and testable on
the hint value.

(b) If the runner is where logging already happens, call `detectFramework` there
and print directly. Only do this if (a) forces an awkward plan-shape change.

Hint text (single line, actionable):
```
this project uses <framework> — the worker runs inside Vite there. run `<pm> run dev` (e.g. `vite`) for the full app; `lunora dev` starts only the worker.
```
Use the already-resolved `manager` to render `<pm> run dev` via `runScriptCommand`
(exported from init util) or an inline equivalent.

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 2: Emit the hint from the runner

Ensure the hint is printed to the logger (info/warn) when present, and that
`lunora dev` still proceeds to spawn wrangler (the hint does not abort). Grep the
dev handler for where the plan is consumed and wrangler is spawned; add the log
just before the spawn.

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass.

### Step 3: Test

Add a case to the dev command's test: `planDevCommand` (or the runner) for a cwd
that `detectFramework` reports as a framework yields a plan carrying the hint;
for a standalone (`framework: "none"`) cwd it does not. Mock `detectFramework`
via `vi.mock` on `@lunora/config` (or the re-export path the handler imports
from), matching existing dev-test mocking style.

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass, new case included.

## Test plan

- New case(s) in the dev command test file:
  - framework project → plan has the redirect hint / runner logs it.
  - standalone project → no hint (byte-identical to today's behavior).
- The wrangler plan (args/command) must be unchanged in both cases — assert the
  `wrangler` descriptor is still present and correct.
- Verification: `pnpm --filter "@lunora/cli" run test` → all pass.

## Done criteria

- [ ] `lunora dev` still spawns `wrangler dev` in every case (behavior unchanged).
- [ ] A framework project additionally prints a one-line redirect hint naming the framework and the `<pm> run dev` command.
- [ ] A standalone project prints no hint.
- [ ] `pnpm --filter "@lunora/cli" run lint:types` and `run test` exit 0.
- [ ] `git status` shows only in-scope files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- `detectFramework` is not importable in the CLI (not re-exported / different
  path than expected) — report; do not reach into `@lunora/config` internals.
- Adding the hint field to `DevCommandPlan` ripples into many consumers/tests —
  prefer logging from the runner (option b) instead, and note the deviation.
- `detectFramework` is expensive or does filesystem work that would slow every
  `lunora dev` invocation noticeably — it should be a cheap config-file probe; if
  not, STOP and report.

## Maintenance notes

- If new framework classes are added to `detect-framework.ts`, confirm the hint
  condition (`framework !== "none"`) still means "runs inside Vite/host".
- A reviewer should confirm the hint does NOT change exit code or abort the
  wrangler spawn — it is purely informational.
