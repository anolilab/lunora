# Plan 327 — Stop publishing a package for a dependency it never imports, and catalog the four that drifted

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/*/package.json pnpm-workspace.yaml pnpm-lock.yaml`
>
> **Lockfile rule:** never text-merge `pnpm-lock.yaml`. If you rebase and it conflicts,
> discard it and regenerate with `pnpm install --lockfile-only`.

## 0. Headline finding

Five independent manifest defects, each small, one of them expensive:

1. **`@lunora/hyperdrive` depends on `@lunora/errors` and never imports it.** Not just
   a dead edge — `packages/hyperdrive/CHANGELOG.md` records **ten** entries reading
   `**@lunora/errors:** upgraded to 1.0.0-alpha.N`. Ten `@lunora/hyperdrive` versions
   published to npm whose only content was a bump to a package it does not use. Every
   `@lunora/errors` release re-publishes hyperdrive.
2. **`jsonc-parser` is a runtime dependency of `@lunora/vite`, imported only by its
   tests.** `@lunora/vite` sits in every project's dev graph, so this is the
   widest-reach dead dependency in the repo.
3. **The Angular toolchain is uncatalogued and has already split**: `@angular/core`
   `^22.0.8` in `packages/angular`, `^22.0.7` in `packages/auth-ui` — and `auth-ui` is
   the source of truth synced into `registry/auth-ui-angular/`, i.e. into code users
   copy into their own projects.
4. **`cron-parser` and `better-sqlite3` are uncatalogued duplicates in two runtime
   manifests each** — the next pair to drift for the same reason.
5. **The lockfile pins `hono` 4.12.32** while the catalog range (`^4.12.32`) already
   permits 4.12.34, which patches four advisories. `@lunora/server` depends on `hono`
   directly, so it pins every downstream app's copy.

`CLAUDE.md:218` states the catalog rule and nothing enforces it.

## 1. Current state (audit)

1. `packages/hyperdrive/package.json:67` — `"@lunora/errors": "1.0.0-alpha.20"`.
   `grep -rn "@lunora/errors" packages/hyperdrive/src` → **no matches**.
2. `packages/vite/package.json:67` — `"jsonc-parser": "catalog:vite"` under
   `dependencies`. `grep -rn "jsonc-parser" packages/vite/src` → no matches; the only
   importers are `packages/vite/__tests__/codegen-plugin.test.ts:5` and
   `packages/vite/__tests__/cron-sync.test.ts:5`.
3. `packages/angular/package.json:68` `^22.0.8` vs `packages/auth-ui/package.json:53`
   `^22.0.7`; `@angular/*` appears nowhere in `pnpm-workspace.yaml`. Also uncatalogued
   and duplicated: `rxjs ^7.8.2`, `zone.js ^0.16.2`, plus
   `@angular/{common,compiler,compiler-cli,platform-browser}` at `^22.0.7` in
   `auth-ui`.
4. `packages/scheduler/package.json:66` and `packages/platform-node/package.json:71` —
   `"cron-parser": "5.6.2"` in **runtime** `dependencies`. `better-sqlite3 ^12.11.1` in
   `packages/auth/package.json:137` (dev) and `packages/platform-node/package.json:70`
   (runtime); `@types/better-sqlite3 ^7.6.13` in both.
5. `pnpm-lock.yaml:18747,18751` — `hono@4.12.30` and `hono@4.12.32` resolved;
   `pnpm-workspace.yaml:525` — `hono: ^4.12.32`; `packages/server/package.json:88` —
   `"hono": "catalog:http"`. The four advisories are all `patched: >=4.12.34`:
   `memo()` retaining SSR output across requests (cross-user disclosure), ReDoS in the
   CORS middleware, algorithmic-complexity DoS in the Language middleware, and the
   Proxy Helper not stripping `Connection`-listed headers.
   **Reachability:** `packages/server/src/http.ts:4-5` imports only `Context` and
   `Hono`; no `hono/cors`, no `memo()`, no proxy or language middleware anywhere in
   `packages/server/src` or `packages/runtime/src`. None is exploitable _through_
   Lunora — the exposure is the version Lunora pins for its users.

## 2. Existing seams (do not reinvent)

- pnpm catalogs in `pnpm-workspace.yaml` — add an `angular` catalog block alongside the
  existing ones; put `cron-parser` and `better-sqlite3` in whichever existing catalog
  fits (read the surrounding blocks and match their grouping).
- `scripts/check-sibling-peer-ranges.js` and `scripts/check-registry-catalog-ranges.js`
  — the existing shape for a repo consistency guard, if WS5 is taken.
- `pnpm run lint:package-json` (= `vis sort-package-json --check`) — key order is
  CI-only and blind to everything else; run it after any manifest edit.

## 3. The behavioural contract to preserve

1. No installed version may change except `hono` (4.12.32 → 4.12.34, inside the
   existing range) and `@angular/*` in `auth-ui` (22.0.7 → 22.0.8, inside one major).
2. Removing `@lunora/errors` from hyperdrive and moving `jsonc-parser` to devDeps must
   not break a build. If either does, the grep missed an import — that is a STOP.
3. Manifest key order must stay canonical (`vis sort-package-json`). The classic
   mistake is a hand-added block placed above `devDependencies` instead of below; it
   passes every local check and reds a CI job of its own.

## 4. Design decisions

**Chosen: catalog `@angular/*`, `rxjs`, `zone.js`, `cron-parser`, `better-sqlite3` and
`@types/better-sqlite3`.** Rejected: only aligning the two Angular versions. That fixes
today's drift and leaves the mechanism that produced it.

**Rejected outright: converting hardcoded _peer_ ranges to `catalog:`.** An audit pass
flagged ~14 peer ranges (`react ^19.2.7` where the catalog holds `19.2.8`, and
similar). A peer range is a _supported_ range, deliberately wider than and independent
of the version we build against — `^19.2.7` already admits `19.2.8`, so nothing is
broken, and narrowing peers to the catalog value would shrink what consumers may
install. `@lunora/auth` and `@lunora/vite` do use `catalog:` in peers, but that is a
per-case judgement, not a rule to generalise. Recorded here so it is not re-audited.

**Chosen: refresh the `hono` lockfile entry only.** Rejected: the audit's claim that
the `hono@4.12.34` line in `pnpm-workspace.yaml:718-719` is "in the wrong YAML key" —
it sits under `minimumReleaseAgeExclude`, which is exactly the key that waives the
release-age hold, and `undici`, `js-yaml` and `dompurify` sit there for the same
reason. The entry is correct; only the lockfile is stale.

## 5. Workstreams

Each workstream is independently landable. Do them as separate commits.

### WS1 — Drop the unused hyperdrive dependency (S)

> **⚠️ CORRECTED 2026-08-11 — this workstream's premise was wrong. Do NOT delete the
> dependency.**
>
> The audit grepped only `packages/hyperdrive/src`. `packages/hyperdrive/tsconfig.json`
> also includes `__tests__/**/*`, and
> `packages/hyperdrive/__tests__/global-dialect.test.ts:1` imports `LunoraError` from
> `@lunora/errors`. Deleting the entry breaks `lint:types` with
> `TS2307: Cannot find module '@lunora/errors'`. The executor hit this, reverted, and
> reported instead of improvising — correctly.
>
> **The underlying finding still stands**: `packem build` itself reports
> `@lunora/errors` as declared-but-unused, and the ten CHANGELOG entries republishing
> hyperdrive for a bump it does not use at runtime are real. **The right fix is to move
> the entry to `devDependencies`**, not to remove it — verified to work locally during
> execution. Re-scope this workstream that way before the next attempt, and check
> `__tests__` as well as `src` for the other manifests.
>
> **General lesson for any "unused dependency" audit in this repo:** grep the whole
> package, not just `src/` — a package's `tsconfig.json` include list is the authority
> on what must resolve.

Delete `"@lunora/errors"` from `packages/hyperdrive/package.json:67`, then
`pnpm install --lockfile-only`.

**Verify:** `pnpm --filter "@lunora/hyperdrive" run build` and `run lint:types` both
exit 0; `grep -rn "@lunora/errors" packages/hyperdrive/src` stays empty.

### WS2 — Move `jsonc-parser` to devDependencies (S)

`packages/vite/package.json` — move the entry, keep `catalog:vite`.

**Verify:** `pnpm --filter "@lunora/vite" run build` and `run test` both exit 0.

### WS3 — Catalog the Angular toolchain and the two runtime duplicates (S)

Add a `catalogs.angular` block (core, common, compiler, compiler-cli,
platform-browser, rxjs, zone.js) pinned at the **higher** existing version (22.0.8),
repoint `packages/angular` and `packages/auth-ui`, and move `cron-parser`,
`better-sqlite3`, `@types/better-sqlite3` into an existing catalog. Then
`pnpm install --lockfile-only`.

**Verify:** `pnpm --filter "@lunora/angular" run lint:types`,
`pnpm --filter "@lunora/auth-ui" run lint:types`, and `pnpm run lint:registry:sync` all
exit 0. The last one matters most — `auth-ui` is the registry source of truth.

### WS4 — Refresh the `hono` resolution (S)

Update the lockfile so `hono` resolves at 4.12.34 (the catalog range already permits
it). Prefer the narrowest command that achieves it; verify by grepping the lockfile,
not by trusting the command's output.

**Verify:** `grep -n "^  hono@" pnpm-lock.yaml` shows 4.12.34 and no 4.12.32/4.12.30
reachable from a `@lunora/*` package; `pnpm --filter "@lunora/server" run test` exits 0.

### WS5 — A guard, if it is cheap (S, optional)

A ~40-line `scripts/check-catalog-drift.js` in the shape of the existing
`check-sibling-peer-ranges.js`: fail when the same package name appears with a
non-`catalog:` spec in **two or more** workspace manifests. Wire it into the
`postinstall` chain only after confirming it passes against the whole repo — a failing
postinstall check turns every CI job red in its setup step, and the cause is invisible
in the job that reports the failure. If it finds more than a handful of pre-existing
violations, **do not** wire it in; land the script with a `--check` flag unwired and
record the list in §9.

## 6. Platform parity

Not applicable — manifests and lockfile only. No `ctx.*` surface, no binding, no
capability change.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                    |
| ----- | ---- | ----------------------------------------------------------------------- |
| 0     | WS1  | hyperdrive builds and typechecks without the dep                        |
| 1     | WS2  | vite builds and tests pass with `jsonc-parser` in devDeps               |
| 2     | WS3  | `lint:registry:sync` and both Angular typechecks pass                   |
| 3     | WS4  | lockfile shows 4.12.34; server suite green                              |
| 4     | WS5  | script passes clean repo-wide, or is landed unwired with the list in §9 |

## Commands you will need

| Purpose             | Command                        | Expected         |
| ------------------- | ------------------------------ | ---------------- |
| Regenerate lockfile | `pnpm install --lockfile-only` | exit 0           |
| Build all           | `pnpm run build:packages`      | exit 0           |
| Registry sync gate  | `pnpm run lint:registry:sync`  | exit 0 (CI-only) |
| Manifest key order  | `pnpm run lint:package-json`   | exit 0 (CI-only) |
| Typecheck all       | `pnpm run lint:types`          | exit 0           |
| Format              | `pnpm run lint:prettier:fix`   | exit 0           |

## Scope

**In scope:**

- `packages/hyperdrive/package.json`, `packages/vite/package.json`,
  `packages/angular/package.json`, `packages/auth-ui/package.json`,
  `packages/scheduler/package.json`, `packages/platform-node/package.json`,
  `packages/auth/package.json`
- `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- `scripts/check-catalog-drift.js` (WS5, optional)

**Out of scope:**

- **Peer-dependency ranges** — see §4; deliberately not touched.
- `pnpm-workspace.yaml`'s `overrides` and `minimumReleaseAgeExclude` semantics — both
  correct as they stand.
- Every dependency whose advisory resolves only through `apps/docs`, the `nuxt` peer
  graph, or dev tooling. Two transitive highs were checked and are un-upgradable from
  this repo: `ip-address` 10.2.0 reaches `mcp`/`agent` only through
  `@modelcontextprotocol/sdk > express-rate-limit`, and Lunora serves MCP through
  `WebStandardStreamableHTTPServerTransport` (`packages/mcp/src/serve-stateless.ts:14`),
  never the Express path; `image-size` 2.0.2 reaches `storage` via
  `@visulima/storage > @netlify/blobs`, and Lunora instantiates `AwsLightStorage`
  (`packages/storage/src/upload-handler.ts:22`), never the Netlify provider. Recorded
  so the next wave does not re-derive it.

## Git workflow

- Branch: `advisor/327-manifest-hygiene`
- One commit per workstream. Suggested: `chore(hyperdrive): drop the unused errors dependency`,
  `chore(vite): move jsonc-parser to devDependencies`,
  `chore(deps): catalog the angular toolchain`, `chore(deps): refresh hono to 4.12.34`

## Test plan

No new unit tests. Verification is the gates above plus:

1. `pnpm run build:packages` exits 0 after every workstream.
2. `pnpm run test` exits 0 at the end (**never** `pnpm -r run test` — it fails an
   arbitrary set each run from resource contention).
3. `git diff pnpm-lock.yaml` contains only the intended resolution changes — read it,
   do not skim it.

## Done criteria

- [ ] `grep -n "@lunora/errors" packages/hyperdrive/package.json` → no match
- [ ] `jsonc-parser` appears under `devDependencies` in `packages/vite/package.json`
- [ ] `grep -n '"@angular/core"' packages/*/package.json` shows `catalog:angular` in both manifests
- [ ] `grep -rn '"cron-parser"' packages/*/package.json` shows a catalog reference in both
- [ ] `grep -n "^  hono@" pnpm-lock.yaml` shows 4.12.34
- [ ] `pnpm run lint:package-json`, `pnpm run lint:registry:sync`, `pnpm run lint:types` all exit 0
- [ ] `pnpm run build:packages` and `pnpm run test` exit 0
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if removing `@lunora/errors` breaks the hyperdrive build. That means a
  transitive or type-only import the grep missed; report the import site rather than
  restoring the dependency silently.
- **STOP** if `hono` 4.12.34 is not actually published, or resolving it drags in an
  unrelated major elsewhere in the graph. Read the lockfile diff.
- **STOP** if WS5's guard finds more than a handful of pre-existing violations. Do not
  wire a failing check into `postinstall` — one failure there turns ~20 CI checks red
  in their setup step.
- **Risk:** the Angular bump to 22.0.8 in `auth-ui` changes what the AOT compiler sees
  for the registry cards. `lint:registry:sync` plus `auth-ui`'s own render tests are
  the gate; run both.

## 9. Open questions

1. WS5: how many pre-existing catalog-drift violations exist repo-wide? List them here
   before deciding whether to wire the check in.
2. Is a `check-unused-dependency` sweep worth it? This audit found exactly one dead
   sibling edge (hyperdrive) across 55 manifests, so a one-off grep may be the right
   tool rather than a permanent gate. Record the call.
