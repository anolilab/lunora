# Plan 098: Make framework templates' `typecheck` script run codegen first

> **Executor instructions**: Follow step by step; run each verify command. STOP
> conditions halt you. Update `plans/README.md` when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- templates`
> If a template's `package.json` or `.gitignore` changed, re-read before editing.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

A scaffolded template ignores its generated `lunora/_generated/` directory (it
does not exist until codegen runs). The `build` script runs `lunora codegen`
first, but the `typecheck` script does not — so a user who scaffolds and
immediately runs `npm run typecheck` (or wires it into CI before the first
`dev`/`build`) gets `Cannot find module '#lunora/_generated/server.js'`. This
contradicts `build` succeeding on the same fresh checkout, which is confusing at
the worst possible moment (first run).

## Current state

Only `templates/react-router` ships a `typecheck` script today (verified:
`grep -n '"typecheck"' templates/*/package.json` returns exactly one match).

`templates/react-router/package.json`:
```json
"dev": "vite",
"build": "lunora codegen && react-router build",
"typecheck": "react-router typegen && tsc"
```

`templates/react-router/lunora/messages.ts:3` imports
`#lunora/_generated/server.js`; `templates/react-router/.gitignore:11` lists
`lunora/_generated` — so the module is absent on a fresh scaffold until codegen
runs. `build` runs `lunora codegen` first; `typecheck` omits it.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Find typecheck scripts | `grep -n '"typecheck"' templates/*/package.json` | one match (react-router) |
| Find build scripts (for ordering reference) | `grep -n '"build"' templates/*/package.json` | build runs `lunora codegen` first |

## Scope

**In scope**: `templates/react-router/package.json` (the `typecheck` script).
If the drift check reveals other templates have since gained a `typecheck`
script that also omits codegen, apply the same fix to those — but only to a
`typecheck` script that both (a) exists and (b) does not already run codegen.

**Out of scope**: adding a `typecheck` script to templates that lack one (that
is a larger consistency change, not this bug); the `build`/`dev` scripts; any
non-template file.

## Git workflow

- Branch: `advisor/098-template-typecheck-runs-codegen`
- Commit: `fix(templates): run codegen before typecheck in react-router`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Prefix codegen

Change `templates/react-router/package.json`:
```json
"typecheck": "lunora codegen && react-router typegen && tsc"
```

**Verify**: `grep -n '"typecheck"' templates/react-router/package.json` → shows
`lunora codegen &&` at the front, before `react-router typegen && tsc`.

### Step 2: Confirm no other template regressed

Re-run `grep -n '"typecheck"' templates/*/package.json`. For any other match
that lacks `lunora codegen`, apply the same prefix.

**Verify**: every `typecheck` script that references `#lunora/_generated`-consuming
code now runs `lunora codegen` first.

## Test plan

No unit test (package.json script). Verification is the grep above. If the
environment has a scaffolded/installed react-router template available, an
optional end-to-end check: delete `lunora/_generated`, run `npm run typecheck`,
confirm it succeeds where it previously failed with the missing-module error.
Skip if deps aren't installed and note it.

## Done criteria

- [ ] `templates/react-router/package.json` `typecheck` begins with `lunora codegen &&`.
- [ ] No other template `typecheck` script omits codegen while importing generated code.
- [ ] `git status` shows only template `package.json`(s) modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The `react-router` template no longer imports `#lunora/_generated/*` (drift) — the fix may be unnecessary; report.
- A template's codegen is invoked by a different command than `lunora codegen` (e.g. a `predev` hook or a different bin) — match that template's own convention rather than hardcoding `lunora codegen`.

## Maintenance notes

- Any template that adds a `typecheck` script must run `lunora codegen` first,
  same as its `build`. Consider documenting this in the template-authoring notes.
- A reviewer should confirm the codegen step is idempotent and fast enough to
  prepend to typecheck without annoying watch-loop overhead (it is a one-shot).
