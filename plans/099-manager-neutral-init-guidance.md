# Plan 099: Stop printing pnpm-only guidance to npm/yarn/bun users

> **Executor instructions**: Follow step by step; run each verify. STOP
> conditions halt you. Update `plans/README.md` when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/cli/src/commands/init templates`
> If `init/handler.ts` or the template READMEs changed, re-read before editing.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (complements 096)
- **Category**: dx
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

`lunora init` lets the user pick npm/yarn/pnpm/bun, but the framework-overlay
"next steps" it prints hardcode `pnpm add …`, and the template READMEs hardcode
`pnpm install` / `pnpm dev`. An npm user who just scaffolded is told to run
commands that either fail (no pnpm on PATH) or silently introduce a second
package manager + lockfile into their project. Lower blast radius than plan 096
(this is printed guidance, not an executed command), but it is concrete copy the
user is told to run, and it undpercuts the "pick your manager" prompt.

## Current state

`packages/cli/src/commands/init/handler.ts:1008-1019` (the framework-overlay
next steps — printed unconditionally with `pnpm`):

```ts
const { adapter, class: frameworkClass, framework } = detection;
logger.info("");
logger.info(`detected framework: ${framework} (class ${frameworkClass})`);
logger.info("next steps:");
logger.info(`  1. install the adapter:  pnpm add ${adapter} @lunora/client @lunora/runtime @lunora/server`);
logger.info("  2. run codegen:          lunora codegen");
// … class-specific step 3 lines follow …
```

The **correct** pattern already used elsewhere in the same file — the
template-fetch path threads the resolved manager (`packages/cli/src/commands/init/handler.ts:449-458`):

```ts
/** The shell command that runs a project script with `manager` (`pnpm dev`, `npm run dev`, …). */
const runScriptCommand = (manager: PackageManager, script: string): string => {
    if (manager === "npm")  return `npm run ${script}`;
    if (manager === "bun")  return `bun run ${script}`;
    // … yarn / pnpm …
};
```

There is also `installArgsFor` in `packages/cli/src/util/detect-package-manager.ts`
(exported alongside `execArgsFor`) — the install-command equivalent. Read it to
see its exact return shape before using it.

Template READMEs hardcode pnpm, e.g. `templates/standalone/README.md:6-9`:
```
## Develop
​```bash
pnpm install
pnpm dev
​```
```

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm --filter "@lunora/cli" run lint:types` | exit 0 |
| Tests | `pnpm --filter "@lunora/cli" run test` | all pass |
| Find hardcoded pnpm in READMEs | `grep -rn 'pnpm ' templates/*/README.md` | the lines to soften |

## Scope

**In scope**:
- `packages/cli/src/commands/init/handler.ts` — the overlay next-steps block
  (~line 1013) and any sibling printed-guidance that hardcodes `pnpm`. Grep the
  file for `pnpm ` to find them all; convert each to use the resolved manager.
- `templates/*/README.md` — soften the hardcoded `pnpm install` / `pnpm dev` to
  a manager-neutral phrasing (see Step 3).
- The init test file `packages/cli/__tests__/commands/init.test.ts` (add/adjust
  an assertion — see Test plan).

**Out of scope**:
- The subprocess-spawning commands (that is plan 096; do not re-do it here).
- Any behavior change to scaffolding itself — only printed strings.

## Git workflow

- Branch: `advisor/099-manager-neutral-init-guidance`
- Commit: `fix(cli): print package-manager-neutral init guidance`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Thread the resolved manager into the overlay next-steps

Locate where the overlay path resolves the `PackageManager` (the interactive
prompt records it; grep `handler.ts` for `PackageManager` and how
`runScriptCommand` is fed elsewhere). Use `installArgsFor(manager, …)` (or a small
`installCommand(manager, pkgs)` string helper mirroring `runScriptCommand`) to
render step 1, so an npm user sees `npm install …` / `npm add`-equivalent, a bun
user `bun add …`, etc. Keep `lunora codegen` (bin, manager-neutral) as-is.

Target shape (illustrative):
```ts
logger.info(`  1. install the adapter:  ${installCommand(manager, [adapter, "@lunora/client", "@lunora/runtime", "@lunora/server"])}`);
```

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 2: Catch sibling hardcoded-pnpm guidance in the same file

`grep -n 'pnpm ' packages/cli/src/commands/init/handler.ts`. For each printed
string (not a spawn — those are plan 096), convert to the manager-aware form. If
a match is a code comment or a spawn descriptor, leave it.

**Verify**: `grep -n 'pnpm ' packages/cli/src/commands/init/handler.ts` returns
only comments/spawn-descriptors (no user-facing `logger.*("… pnpm …")`).

### Step 3: Soften the template READMEs

In each `templates/*/README.md`, replace the hardcoded `pnpm install` / `pnpm
dev` fenced block with manager-neutral wording. Two acceptable forms — pick one
and apply consistently:
- Neutral prose: "Install dependencies and start the dev server with your
  package manager (`npm`, `pnpm`, `yarn`, or `bun`):" then a generic
  `<pm> install` / `<pm> run dev` note; **or**
- Keep a concrete example but note it: "Using pnpm (swap for your package
  manager):".

Prefer the first (fully neutral) form.

**Verify**: `grep -rn 'pnpm install\|pnpm dev' templates/*/README.md` → no bare
hardcoded matches (or only inside an explicit "swap for your manager" note).

### Step 4: Test the overlay guidance

Add/adjust an assertion in `packages/cli/__tests__/commands/init.test.ts`: when
init runs an overlay with the manager resolved to npm, the printed next-steps
include `npm ` (not `pnpm add`). Mock the logger and assert on captured lines,
matching however existing init tests capture logger output.

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass.

## Test plan

- New/updated case in `packages/cli/__tests__/commands/init.test.ts`: overlay
  next-steps rendered under an npm project contain an `npm`-form install command
  and no `pnpm add`. Model logger capture after the existing init tests.
- Verification: `pnpm --filter "@lunora/cli" run test` → all pass.

## Done criteria

- [ ] The overlay next-steps install line uses the resolved package manager.
- [ ] `grep -n 'pnpm ' packages/cli/src/commands/init/handler.ts` shows no user-facing pnpm-hardcoded guidance.
- [ ] Template READMEs no longer hardcode bare `pnpm install`/`pnpm dev` (or note the swap).
- [ ] `pnpm --filter "@lunora/cli" run lint:types` and `run test` exit 0.
- [ ] `git status` shows only in-scope files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The overlay path does not actually have the resolved `PackageManager` in scope
  and threading it requires a signature change rippling through many callers —
  STOP and report; a smaller fix (default the guidance to neutral prose) may be
  preferable.
- `installArgsFor`'s shape doesn't fit string rendering cleanly — write a tiny
  local `installCommand(manager, pkgs): string` mirroring `runScriptCommand`
  rather than forcing it.

## Maintenance notes

- New printed guidance in the CLI should always render commands via the
  manager-aware helpers, never a literal `pnpm`.
- A reviewer should check every template README, not just `standalone`.
