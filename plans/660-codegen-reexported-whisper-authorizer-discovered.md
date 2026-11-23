# Plan 660: A whisper authorizer re-exported into `lunora/` is registered, or the build fails

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/codegen/src/discover/functions/index.ts packages/codegen/src/discover/attribution.ts packages/codegen/src/discover/unregistered-procedures.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Codegen discovers registrations (functions, lifecycle hooks, `onWhisper` authorizers, `defineWebSocket` routes) by walking each `lunora/` file's own top-level variable declarations:

```ts
    const found = source
        .getVariableStatements()
        .flatMap((statement) => statement.getDeclarations())
        .flatMap((declaration) => exportCallsOfDeclaration(declaration, (localName) => exportNames.has(localName)))
        .flatMap(([localName, call]) =>
            (exportNames.get(localName) ?? [])
```

Two ordinary ways of exposing something defined elsewhere are never seen: `import { gate } from "../src/auth/whisper"; export { gate };` and `export { gate } from "../src/auth/whisper";`. The safety-net lint `procedure_not_registered` has the same blind spot (`attribution.ts` ~595, `exportedVariableDeclarationsOf` also uses `getVariableStatements()`). For most registrations a miss is a dead feature. For the whisper authorizer it fails **open** — the code says so:

```ts
        },
    ],
    [
        "RegisteredWhisperAuthorizer",
        {
            call: "onWhisper(handler)",
            // The one entry here whose silent failure is a SECURITY failure rather
            // than a dead feature: an undiscovered authorizer leaves the manifest
            // empty, and an empty manifest means allow-all.
            note: "A dropped authorizer has no caller to fail — the whisper topics it was meant to gate silently stay open to every socket on the shard.",
        },
    ],
    [
        "SubscriptionDefinition",
```

and the runtime:

```ts
const paths = this.lifecycleHookPaths("whisper");

if (paths.length === 0) {
    return true;
}
```

So an authorizer kept in shared app code and re-exported from `lunora/` builds with no finding, and any socket can join and broadcast on whisper topics the author meant to gate (cursors, presence, typing on a private document). Even for the shapes the lint does catch, the finding is `WARN` (`unregistered-procedures.ts` ~265), so builds are not blocked. **Read, not run**: step 1 proves it with a fixture.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                                     | Expected on success |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                            | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/codegen..." run build`                              | exit 0              |
| One test file                 | `pnpm --filter "@lunora/codegen" exec vitest run __tests__/discover/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/codegen" run test`                                  | all pass            |
| Types                         | `pnpm --filter "@lunora/codegen" run lint:types`                            | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/codegen" run lint:eslint`                           | exit 0, 0 warnings  |

## Design (decided)

Two layers, in this order:

1. **Fail closed in the lint (must land).** Make `procedure_not_registered` see both re-export shapes: an export specifier whose binding is an import, and an `export { x } from "…"`. Resolve the exported symbol to its declaration across files (ts-morph: alias → `getAliasedSymbol()` → declarations) and apply the existing "is this a registration call" test to its initializer. For a registration kind whose silent drop is a **security** failure — today only the whisper authorizer; drive it from the table that already carries that note, with an explicit flag rather than matching the note text — the finding is `ERROR`, which blocks `vite build` and deploy. Other kinds stay `WARN`. The message names the export, the file it resolves to, and the fix ("define it in a file under lunora/, or assign it there: `export const gate = onWhisper(...)`").
2. **Discover it (do if contained).** If following the alias in discovery (`functions/index.ts`) is a local change — the resolved declaration can be fed to the same `exportCallsOfDeclaration` path and the emitted registry imports from the `lunora/` file's export, not from the outside file — do it, so the authorizer simply works and the ERROR never fires for it. If it would change what `api.ts` contains for existing projects (previously dropped functions suddenly registered) beyond the hook kinds, **do not** widen discovery: keep layer 1 only and say so.

## Steps

1. Fixtures first under `packages/codegen/__tests__` (follow the unregistered-procedures tests): a `lunora/` file that re-exports an `onWhisper(...)` authorizer defined outside `lunora/`, in both shapes → today: no finding and an empty whisper manifest (assert both, red). Then the target: ERROR finding (layer 1) or the authorizer present in the emitted lifecycle hooks (layer 2). Same two shapes for an ordinary query → WARN, unchanged registration behaviour. 2. Implement layer 1, then decide layer 2. 3. Run the codegen package tests; if golden fixtures change, regenerate with the package's own mechanism and list what changed. 4. Docs: the whisper/authorizer docs get one sentence on where an authorizer must be defined (`rg -n -i "onWhisper" apps/docs packages/*/docs | head`). 5. Build, test, types, eslint for `@lunora/codegen`; run the examples' codegen only if a documented per-example command exists and a discovery change makes their output differ.

## Git workflow

- Branch: `security/codegen-reexported-whisper-authorizer`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(codegen): fail a dropped whisper authorizer`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- A first-party example, template or registry item re-exports a registration into `lunora/` and would now fail the build (`ERROR`) or change output: list them; fix the example in the same commit if it is a one-line move, otherwise STOP.
- Resolving aliases across files makes discovery measurably slower on the largest example (more than ~20% on the codegen test suite's timing): keep the lint-only layer and report the numbers.
