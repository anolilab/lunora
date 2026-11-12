# Plan 555 — Align versions pinned differently across pnpm catalogs, and gate the drift

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in "STOP conditions"
> occurs, stop and report — do not improvise. Do NOT update `plans/README.md`; the reviewer
> maintains the index.
>
> **Drift check (run first)**:
> `git diff --stat 90c9b63f4..HEAD -- pnpm-workspace.yaml scripts/check-catalog-drift.js scripts/workspace-config.js`
> must print nothing. If it prints anything, STOP.

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW · **Category**: deps / dx
- **Depends on**: none
- **Planned at**: commit `90c9b63f4` (origin/alpha), 2026-11-12. Supersedes the 2026-11-11 draft
  written at `4a7c48bfd`; the recount below was redone at `90c9b63f4`.
- **State**: DONE: PR anolilab/lunora#1590 (17 aligned, 6 allowlisted; the tanstack router/start
  pair moved to the allowlist after the first run, see below). Step 2's table lists all 19
  candidates; the shipped change reverts the two tanstack rows.

## Why this matters

`pnpm-workspace.yaml` has 39 named catalogs. 42 dependency names appear in more than one catalog,
and 23 of them carry different specifiers. Nothing compares catalogs with each other:
`scripts/check-catalog-drift.js` only catches a literal version hand-typed in two manifests. So a
`vis update` that bumps one catalog leaves the other behind, silently. The `web` catalog (only
`apps/docs` uses it) already lags: its `vite: 8.3.2` does not satisfy the `vite: ^8.3.3` peer of
three other packages in the same catalog. After this plan, every shared name has one specifier,
except the deliberate splits on an allowlist with reasons, and CI fails on any new split.

## Current state (verified at `90c9b63f4`)

### The 23 differing names

Resolved versions come from the `catalogs:` block of `pnpm-lock.yaml`. Consumers are the
workspace manifests that reference that catalog for that name.

| Name                               | Catalog A (consumers)                                                      | `web` / other side (consumers)                                       | Lock resolves                                     |
| ---------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| `@babel/core`                      | build `^8.1.0` (root, packages/react, solid, studio)                       | web `8.0.6` (apps/docs)                                              | 8.1.0 / 8.0.6                                     |
| `@tanstack/react-router`           | frontend `^1.170.46` (packages/studio, examples/tanstack-start)            | web `1.170.41`                                                       | .46 / .41                                         |
| `@tanstack/react-start`            | frontend `^1.169.4` (examples/tanstack-start)                              | web `1.168.60`                                                       | 1.169.4 / 1.168.60                                |
| `@tanstack/react-virtual`          | frontend `^3.14.25` (packages/studio)                                      | web `3.14.13`                                                        | .25 / .13                                         |
| `motion`                           | frontend `^14.9.0` (packages/studio)                                       | web `14.0.0`                                                         | 14.9.0 / 14.0.0                                   |
| `vite`                             | vite `^8.3.5` (apps/bench, playground, studio, packages/vite, 16 examples) | web `8.3.2`                                                          | 8.3.5 / 8.3.2                                     |
| `@tailwindcss/vite`                | vite `^4.3.3` (apps/studio)                                                | web `4.3.3`                                                          | same                                              |
| `tailwindcss`                      | vite `^4.3.3` (apps/studio, packages/studio)                               | web `4.3.3`                                                          | same                                              |
| `class-variance-authority`         | ui `^0.7.1` (packages/studio)                                              | web `0.7.1`                                                          | same                                              |
| `clsx`                             | ui `^2.1.1` (packages/studio)                                              | web `2.1.1`                                                          | same                                              |
| `tailwind-merge`                   | ui `^3.7.0` (packages/studio)                                              | web `3.7.0`                                                          | same                                              |
| `@testing-library/jest-dom`        | frontend `^7.0.1` (5 projects)                                             | web `7.0.1`                                                          | same                                              |
| `@testing-library/react`           | frontend `^16.3.3` (6 projects)                                            | web `16.3.3`                                                         | same                                              |
| `@types/react`, `@types/react-dom` | frontend `^19.3.0` (~25 projects)                                          | web `19.3.0`                                                         | same                                              |
| `react`, `react-dom`               | frontend `^19.3.1` (~25 projects)                                          | web `19.3.1`                                                         | same (root `overrides.react: 19.3.1` wins anyway) |
| `eslint-plugin-react-compiler`     | lint `^19.1.0-rc.2` (root devDeps)                                         | web `19.1.0-rc.2`                                                    | same                                              |
| `eslint-plugin-react-hooks`        | lint `7.1.1` (root devDeps)                                                | web `^7.1.1`                                                         | same                                              |
| `jiti`                             | tooling `^2.7.0` (packages/codegen, packages/config — `dependencies`)      | cli `2.7.0` (packages/cli — `dependencies`)                          | same                                              |
| `solid-js`                         | frontend `^1.9.18` (packages/auth-ui, solid)                               | solid2 `2.0.0-rc.0` (tests/auth-ui-solid-v2, tests/solid-v2-adapter) | 1.9.18 / 2.0.0-rc.0                               |
| `vite-plugin-solid`                | frontend `^2.11.15`                                                        | solid2 `^3.0.0-next.27`                                              | 2.11.15 / 3.0.0-next.27                           |
| `@solidjs/testing-library`         | frontend `^0.8.10`                                                         | solid2 `1.0.0-beta.2`                                                | 0.8.10 / 1.0.0-beta.2                             |

### Evidence the `web` pins lag (not deliberate)

- `git log -S` on `pnpm-workspace.yaml`: `vite: 8.3.2`, `motion: 14.0.0`, `"@babel/core": 8.0.6`,
  `"@tanstack/react-virtual": 3.14.13` came from a bulk `deps: update to latest` (f7cfaa673). The
  router/start pins came from 61c1d932e, which bumped react-start to 1.168.60 as the _minimum_
  peer of `@tanstack/start-static-server-functions` — a floor, not a ceiling.
- Peers in `pnpm-lock.yaml` `packages:`: `@vitejs/plugin-react@6.1.1`, `@rolldown/plugin-babel@0.2.4`
  and `vite-imagetools@12.0.1` (all in `web`) peer `vite: ^8.3.3`, which `web`'s `vite: 8.3.2`
  violates. `@tanstack/react-start@1.169.4` also peers `vite: ^8.3.3`, so vite and react-start must
  move together. `@tanstack/start-static-server-functions@1.167.39` peers react-start `^1.168.60`
  and `@tanstack/react-router-devtools@1.167.2` peers react-router `^1.170.36`: both still
  satisfied after the alignment.
- The `web` catalog's header comment says it is isolated "so the heavy web stack never perturbs
  the framework packages' version pins". Aligning `web` up to the framework catalogs' strings
  changes no framework pin.

### Finding from the first execution (2026-11-12): the tanstack router/start pins are coherent

The first executor run stopped on the router-core check, and the stop was right. At `90c9b63f4`
apps/docs resolves ONE `@tanstack/router-core` (1.171.34): `react-router@1.170.41`,
`react-start-client@1.168.39` and `start-static-server-functions@1.167.39` →
`start-client-core@1.170.34` all point at it. Moving `web`'s react-router/react-start to the
`frontend` versions puts docs on router-core 1.171.39 while `start-static-server-functions@1.167.39`
keeps pulling 1.171.34, which leaves two copies. So `@tanstack/react-router` and `@tanstack/react-start`
move to the allowlist, and the alignment covers the other 17 names. Closing this split means bumping
`start-static-server-functions` (web-only) together with the pair, which is an owner decision.

### Deliberate (allowlist)

- `@tanstack/react-router`, `@tanstack/react-start`: see the finding above.

- `solid-js`, `vite-plugin-solid`, `@solidjs/testing-library`: the `solid2` catalog comment says it
  is "kept OUT of the `frontend` catalog so the two majors move independently" and is exact-pinned
  at rc.0 / beta.2 because later RCs break the tests/auth-ui-solid-v2 specs.
- `jiti`: same resolved version, but **both** sides feed published `dependencies` (`@lunora/cli`
  vs `@lunora/codegen` and `@lunora/config`), so aligning either side changes a shipped range.
  That is an owner decision, not a mechanical alignment.

### The existing gate

`scripts/check-catalog-drift.js` (run as `pnpm run lint:catalog-drift` by the
`dependency-manifests` job in `.github/workflows/lint.yml`). `.github/file-filters.yml`'s
`dependency_manifests` filter already lists `pnpm-workspace.yaml` and
`scripts/check-catalog-drift.js`, so **no CI wiring changes**. `scripts/workspace-config.js` exports
`catalogs()` → `{ catalogName: { pkg: specifier } }`; `check-cerebro-peer-lockstep.js` already
imports it (`import { catalogs as readCatalogs } from "./workspace-config.js";`). No `scripts/`
checker has a unit test; the proof for the new rule is a planted split (Step 5).

## Commands you will need

| Purpose             | Command (run from the worktree root)                     | Expected           |
| ------------------- | -------------------------------------------------------- | ------------------ |
| Install             | `pnpm install`                                           | exit 0             |
| Regenerate lockfile | `pnpm install --lockfile-only`                           | exit 0             |
| Gate                | `pnpm run lint:catalog-drift`                            | exit 0, `✅` lines |
| Manifest order      | `pnpm run lint:package-json`                             | exit 0             |
| Docs build          | `pnpm --filter "@lunora/docs..." run build`              | exit 0             |
| Docs types          | `pnpm --filter "@lunora/docs" run lint:types`            | exit 0             |
| Docs tests          | `pnpm --filter "@lunora/docs" run test`                  | exit 0             |
| Format              | `pnpm exec oxfmt --check scripts/check-catalog-drift.js` | exit 0             |
| Lint                | `pnpm exec oxlint scripts/check-catalog-drift.js`        | 0 errors           |

Never run `pnpm run build`, `pnpm run build:packages`, `pnpm run test`, `pnpm run test:workerd`,
or `pnpm -r …`.

## Scope

**In scope (the only files you may modify):**

- `pnpm-workspace.yaml` — only the `web:` catalog lines listed in Step 2.
- `pnpm-lock.yaml` — only via `pnpm install --lockfile-only`. Never hand-edit it.
- `scripts/check-catalog-drift.js`.

**Out of scope:** every other catalog's lines (including `cli`/`tooling` jiti and `solid2`), any
`package.json`, any file under `apps/docs/` (if docs needs a source change, that is a STOP),
`scripts/workspace-config.js`, CI workflows, `plans/`.

## Git workflow

Branch is already checked out (`deps/improve-555-catalog-alignment`). Two commits, conventional
format, header ≤ 100 chars, body lines ≤ 100 chars, end each body with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage explicit paths only (never
`git add -A`, never `git stash`, never `--no-verify`). Do not push.

1. `deps: align the web catalog with the framework catalogs` — `pnpm-workspace.yaml` + `pnpm-lock.yaml`.
2. `build: fail lint:catalog-drift on specifiers that differ across catalogs` — the script.

## Steps

### Step 1: Install and baseline

`pnpm install`, then `pnpm run lint:catalog-drift`. **Verify**: both exit 0.

### Step 2: Edit the `web` catalog (and nothing else in the file)

In the `web:` block of `pnpm-workspace.yaml` replace each value exactly, leaving keys, quoting,
order and comments untouched. The new string is always the other catalog's specifier verbatim:

| Line in `web:`                 | Old           | New            |
| ------------------------------ | ------------- | -------------- |
| `"@babel/core"`                | `8.0.6`       | `^8.1.0`       |
| `"@tailwindcss/vite"`          | `4.3.3`       | `^4.3.3`       |
| `"@tanstack/react-router"`     | `1.170.41`    | `^1.170.46`    |
| `"@tanstack/react-start"`      | `1.168.60`    | `^1.169.4`     |
| `"@tanstack/react-virtual"`    | `3.14.13`     | `^3.14.25`     |
| `"@testing-library/jest-dom"`  | `7.0.1`       | `^7.0.1`       |
| `"@testing-library/react"`     | `16.3.3`      | `^16.3.3`      |
| `"@types/react"`               | `19.3.0`      | `^19.3.0`      |
| `"@types/react-dom"`           | `19.3.0`      | `^19.3.0`      |
| `class-variance-authority`     | `0.7.1`       | `^0.7.1`       |
| `clsx`                         | `2.1.1`       | `^2.1.1`       |
| `eslint-plugin-react-compiler` | `19.1.0-rc.2` | `^19.1.0-rc.2` |
| `eslint-plugin-react-hooks`    | `^7.1.1`      | `7.1.1`        |
| `motion`                       | `14.0.0`      | `^14.9.0`      |
| `react`                        | `19.3.1`      | `^19.3.1`      |
| `react-dom`                    | `19.3.1`      | `^19.3.1`      |
| `tailwind-merge`               | `3.7.0`       | `^3.7.0`       |
| `tailwindcss`                  | `4.3.3`       | `^4.3.3`       |
| `vite`                         | `8.3.2`       | `^8.3.5`       |

**Verify**: `git diff --stat` shows only `pnpm-workspace.yaml`, 19 insertions, 19 deletions.

### Step 3: Regenerate the lockfile

`pnpm install --lockfile-only`, then `pnpm install` (so `node_modules` matches).

**Verify** each of:

- `git diff --stat` shows only `pnpm-workspace.yaml` and `pnpm-lock.yaml`.
- In `pnpm-lock.yaml`'s `catalogs.web` block, every one of the 19 names has `version:` equal to the
  counterpart catalog's `version:` (e.g. `web.vite.version: 8.3.5`, `web.motion.version: 14.9.0`,
  `web['@babel/core'].version: 8.1.0`, `web['@tanstack/react-start'].version: 1.169.4`). If any
  resolves to a different version than its counterpart, STOP and report the list.
- `pnpm --filter "@lunora/docs" why @tanstack/router-core` shows a single version. Two versions → STOP.
- Record for the report: `git diff --stat -- pnpm-lock.yaml`, and the list of `packages:` keys
  removed/added (`git diff pnpm-lock.yaml | grep -E "^[-+]  '?[@a-z]"`). Expected: removed entries
  are the old versions (vite 8.3.2, motion 14.0.0, @babel/core 8.0.6, the old tanstack trio) and
  things only they pulled in; snapshot keys re-keyed from `vite@8.3.2` to `vite@8.3.5`. Anything
  else, list it under NOTES as "pnpm re-resolution" — do not try to fix it.

### Step 4: Verify the consumers (apps/docs is the only consumer of `web`)

1. `pnpm --filter "@lunora/docs..." run build` → exit 0. The build runs `scripts/fetch-stats.js`,
   which reaches the network; if the ONLY failure is a network error from fetch-stats, report it as
   such (not a dependency failure) and continue.
2. `pnpm --filter "@lunora/docs" run lint:types` → exit 0.
3. `pnpm --filter "@lunora/docs" run test` → exit 0.
4. `pnpm run lint:package-json` → exit 0.

If 1–3 fail for any other reason, do not change docs source. Bisect instead: revert ONE family at
a time in `pnpm-workspace.yaml` (families: {vite, @tanstack/react-start, @tanstack/react-router}
together; @babel/core; motion; @tanstack/react-virtual), re-run Step 3 and the failing command,
and find which family causes it. Restore the other families, leave the culprit family at its old
`web` value, and put each of its names on the allowlist in Step 5 with the failing output (first
~10 lines) summarised as the reason. If bisection does not isolate one family, STOP.

Commit 1 now (stage `pnpm-workspace.yaml pnpm-lock.yaml` explicitly).

### Step 5: Extend the gate

In `scripts/check-catalog-drift.js`, after the existing manifest check and before the final
`console.log`, add a second check (keep the existing check and its messages unchanged; let both
checks run and exit 1 at the end if either found violations):

- `import { catalogs, workspaceGroups } from "./workspace-config.js";`
- An allowlist `Map` from name → reason, exactly these four (plus any culprit from Step 4):
    - `solid-js`, `vite-plugin-solid`, `@solidjs/testing-library`: "solid2 catalog tracks the Solid 2
      RC on purpose: it moves independently of frontend's Solid 1 (see the solid2 comment in
      pnpm-workspace.yaml)".
    - `jiti`: "tooling (^2.7.0) and cli (2.7.0) both ship in published dependencies (@lunora/codegen,
      @lunora/config vs @lunora/cli); aligning either changes a published range, so it is the
      owner's call".
- Group every catalog entry by name; for a name whose specifier strings are not all identical
  (plain string comparison — do NOT treat `^X` and `X` as equal) and that is not allowlisted,
  print `❌ "<name>" has different specifiers across catalogs: <catalog>=<spec>, <catalog>=<spec>`.
- For each allowlisted name whose specifiers are now all identical (or that is in fewer than two
  catalogs), print `❌ "<name>" is on the cross-catalog allowlist but no longer differs — remove it`
  and count it as a violation (keeps the list from rotting).
- On success print `✅ No dependency has different specifiers across catalogs (<n> allowlisted).`
- Update the file's top doc comment with one short paragraph saying the script also compares
  catalogs with each other and why (a bump to one catalog silently leaves the other behind). Match
  the style of the existing comment; comments say why, not what.
- Match the existing code style (4-space indent, double quotes, arrow functions, template strings).

**Verify**:

1. `pnpm run lint:catalog-drift` → exit 0, prints both `✅` lines.
2. Planted split: change the `web` `motion` line back to `14.0.0`, run `pnpm run lint:catalog-drift`
   → exit 1 with `❌ "motion" has different specifiers across catalogs: frontend=^14.9.0, web=14.0.0`
   (order of catalogs may differ). Restore `^14.9.0`; `git diff --stat -- pnpm-workspace.yaml`
   prints nothing again.
3. Stale allowlist: temporarily add `["clsx", "test"]` to the allowlist, run → exit 1 with the
   "no longer differs" message. Remove it.
4. `pnpm exec oxfmt --check scripts/check-catalog-drift.js` and
   `pnpm exec oxlint scripts/check-catalog-drift.js` → clean.

Paste the outputs of 1–3 in the report. Commit 2 (stage `scripts/check-catalog-drift.js` only).

## Done criteria

- [ ] `git diff --stat origin/alpha..HEAD` lists exactly `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
      `scripts/check-catalog-drift.js`; `pnpm-workspace.yaml` changes only `web:` lines.
- [ ] `pnpm run lint:catalog-drift` exits 0; the planted split makes it exit 1.
- [ ] `pnpm run lint:package-json` exits 0.
- [ ] `@lunora/docs` build (or only a fetch-stats network failure, reported), `lint:types`, `test` pass.
- [ ] Every `catalogs.web` entry for the 19 names resolves to the same version as its counterpart.
- [ ] Two commits, conventional headers, hooks not bypassed.

## STOP conditions

- The drift check prints anything, or a Step 2 "Old" value does not match the file.
- A `catalogs.web` entry resolves to a different version than its counterpart after Step 3.
- Two `@tanstack/router-core` versions under apps/docs.
- A docs failure that bisection in Step 4 cannot pin on one family, or that needs a docs source edit.
- `pnpm install` fails, or the lockfile diff touches importers other than `apps/docs` beyond
  re-keyed snapshots (report the list; do not fix).
- Any step's verification fails twice.

## Maintenance notes

- `vis update --latest` rewrites catalogs independently; the new gate turns the next split red in
  the `dependency-manifests` job instead of letting it sit.
- Allowlist entries must carry a reason; the stale-entry rule forces removal once a split closes.
- `jiti` is an owner decision: either loosen `cli` to `^2.7.0` (lets consumers dedupe with
  codegen/config) or keep the CLI exact on purpose and say so in a comment.
- The `web` catalog now uses carets for these 19 names; `saveExact: true` still makes new entries
  exact by default, so the gate (not convention) is what keeps them equal.
