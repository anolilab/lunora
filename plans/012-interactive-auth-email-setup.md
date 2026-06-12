# Plan 012: Ask about auth/email at `cirrus init` and add them on demand with `cirrus add`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 92f719ab..HEAD -- packages/cli/src/commands/init packages/cli/src/commands/registry packages/config/src/prompt.ts registry`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none (complements plan 011; if 011 lands, the "Add email?" path
  can default to the dev mail catcher)
- **Category**: dx
- **Planned at**: commit `92f719ab`, 2026-06-12

## Why this matters

Right now `cirrus init` scaffolds a project and stops. Auth and transactional
email — two of the first things a real app needs — are a manual,
read-the-docs-yourself step: the user has to discover `cirrus registry add auth`
/ `cirrus registry add mail`, know they exist, and run them. New users don't.

Cirrus already has the whole machine to set these up correctly: the **registry**
(`packages/cli/src/commands/registry/`) resolves an item's deps, reconciles
`wrangler.jsonc` bindings, scaffolds `.dev.vars`, and copies owned source files
(`registry/auth`, `registry/mail`, …). What's missing is the *offer*: nobody
asks the user "do you want auth? do you want email?" — at init, or later.

This plan adds two front doors, both thin wrappers over the existing registry so
there is **one** code path that knows how to install a capability:

1. **`cirrus init` becomes (optionally) interactive** — after scaffolding it
   asks "Add authentication?" and "Add transactional email?" and, on yes, applies
   the matching registry item(s) into the just-created project.
2. **`cirrus add <feature>`** — a discoverable later-stage command (`cirrus add
   auth`, `cirrus add email`) that asks the relevant follow-ups (provider choice,
   capture-in-dev) and applies the registry item to an existing project.

Both honor non-interactive contexts (CI, `--yes`, piped stdin) via the existing
TTY-aware prompt helper, so nothing hangs in automation.

## Design decisions (already made — do not relitigate)

- **Build on the existing registry.** Do **not** write fresh scaffolding that
  duplicates binding/`.dev.vars`/file logic. `cirrus init --interactive` and
  `cirrus add` both resolve to `applyRegistryItem(...)` (the function the
  `registry add` command already calls).
- **Cloudflare is the default email provider** (see plan 011). The "Add email?"
  flow scaffolds the Cloudflare Email Workers setup (the `send_email` binding +
  `MAIL_FROM`) and, in dev, the mail catcher — not Resend. Resend stays an
  alternative the prompt can offer.
- **Auth provider choice maps to existing registry items.** `auth` (email +
  password, the default), `auth-clerk`, `auth-auth0` already exist under
  `registry/`. The auth prompt picks among them.

## Current state

### Init is non-interactive

- `packages/cli/src/commands/init/index.ts` — command metadata/options; the
  `-t` template list lives here (`vite | standalone | astro | nuxt | sveltekit |
  tanstack-start`).
- `packages/cli/src/commands/init/handler.ts` — orchestration: fetch template via
  `giget` from `gh:anolilab/cirrus/templates/<type>#v<cliVersion>` (fallback
  `alpha`), `{{name}}` substitution, optional `--here` in-place init with
  framework detection. **No prompts today.**

### The registry is the install engine

- `packages/cli/src/commands/registry/commands.ts` — orchestrators (`add`,
  `list`, `view`, `build`). Find the exported "add" entry point and the function
  it delegates to (the apply pipeline); the new flows call that same function.
- `packages/cli/src/commands/registry/apply.ts` — applies deps (structural
  `package.json` edits), bindings (`wrangler.jsonc` via `jsonc-parser`), env vars
  (`.dev.vars` scaffold; secrets get empty placeholders, non-secrets get values).
- `packages/cli/src/commands/registry/reconcile.ts` — `schema-extension` AST
  merges; `types.ts` — manifest + options shapes.
- Items: `registry/{auth,auth-clerk,auth-auth0,mail,storage,backup,crons,presence,ratelimit}/registry.json`.
  `auth` pulls `@cirrus/auth` + scaffolds `cirrus/auth/index.ts`; `mail` pulls
  `@cirrus/mail` + scaffolds `cirrus/mail/index.ts`. (Plan 011 updates `mail`'s
  manifest to the Cloudflare default + catcher.)

### The prompt helper already handles TTY/CI

- `packages/config/src/prompt.ts` — `promptYesNo(message, { defaultYes })` and
  `createConfirm(prefix)`, built on Node `readline`, `isInteractive()`-gated so
  non-interactive contexts auto-decline. This is the only prompting primitive;
  reuse it. For the auth provider *choice* (more than yes/no) add a minimal
  `promptSelect(message, options)` here in the same TTY-aware style rather than
  pulling in a prompt library.

## Commands you will need

| Purpose            | Command                                                       | Expected on success |
| ------------------ | ------------------------------------------------------------- | ------------------- |
| Install            | `pnpm install`                                                | exit 0              |
| CLI tests          | `pnpm --filter "@cirrus/cli" run test`                        | all pass            |
| Config tests       | `pnpm --filter "@cirrus/config" run test`                     | all pass            |
| Typecheck          | `pnpm --filter "@cirrus/cli" run lint:types && pnpm --filter "@cirrus/config" run lint:types` | exit 0 |
| Lint               | `pnpm --filter "@cirrus/cli" run lint:eslint`                 | exit 0              |
| Manual init smoke  | `node packages/cli/dist/index.mjs init demo -t vite` (then with prompts) | scaffolds + offers |

## Scope

**In scope** (the only files/areas you should modify):

- `packages/config/src/prompt.ts` — add `promptSelect` (TTY-aware), keep the
  existing helpers; export from `packages/config/src/index.ts`.
- `packages/cli/src/commands/init/` — add an `--interactive`/`-i` flag (and a
  `--yes` escape) to `index.ts`; in `handler.ts`, after a successful scaffold and
  when interactive, offer auth + email and apply the chosen registry item(s) into
  the new project dir. Skip the offer entirely under `--here` only if that
  complicates things — prefer supporting both.
- `packages/cli/src/commands/add/` — a new thin command: `cirrus add <feature>`
  where feature ∈ {`auth`, `email`/`mail`}. It prompts the relevant follow-ups
  and calls the same registry apply function `registry add` uses. Register it in
  the CLI command table next to `init`/`registry`.
- `packages/cli/__tests__/` and `packages/config/__tests__/` — tests for the
  prompt helper and the two flows (drive them non-interactively + with a fake
  TTY/answers).
- `registry/mail/registry.json` + `registry/auth/registry.json` `docs` strings
  only if the new flows need a one-line post-install hint (keep edits minimal;
  plan 011 owns the mail manifest's provider change).

**Out of scope** (do NOT touch):

- The registry apply pipeline internals (`apply.ts`, `reconcile.ts`) — call them,
  don't change them. If an item can't be applied into a fresh-init dir without a
  pipeline change, STOP and report.
- Template *contents* under `templates/` (this plan adds capabilities post-scaffold
  via the registry, it does not bake auth/email into templates).
- `cirrus init`'s template-fetch/substitution logic.
- The `@cirrus/auth` / `@cirrus/mail` runtime packages.

## Git workflow

- Branch: `dx/interactive-auth-email-setup` off `alpha`.
- Conventional commits, e.g.:
  - `feat(config): TTY-aware promptSelect helper`
  - `feat(cli): offer auth + email after cirrus init`
  - `feat(cli): cirrus add <feature> for later setup`
- Do not push or open a PR unless asked.

## Steps

### Step 1 — `promptSelect` in `@cirrus/config`

Add `promptSelect<T extends string>(message, options: { value: T; label: string;
hint?: string }[], { default? }): Promise<T | undefined>` in `prompt.ts`, mirroring
`promptYesNo`'s structure and `isInteractive()` gate (return the default — or
`undefined` — non-interactively). Export it. Add unit tests with a fake readline.

**Verify**: `pnpm --filter "@cirrus/config" run test` passes; `lint:types` 0.

### Step 2 — Find and expose the registry apply entry point

In `packages/cli/src/commands/registry/commands.ts`, identify the function the
`add` orchestrator calls to apply one item by name into a project dir (resolve
manifest → deps → bindings → env vars → files). If it is not already importable,
export it (named) so `init` and `add` can call it directly. Do not duplicate it.

**Verify**: `pnpm --filter "@cirrus/cli" run lint:types` 0; existing registry tests
still pass.

### Step 3 — Interactive `cirrus init`

1. Add `--interactive`/`-i` and `--yes`/`-y` options to
   `init/index.ts`. Decide the default: interactive when stdin is a TTY and the
   user did not pass `--yes`; never interactive in CI (the prompt helper already
   guarantees this, but gate the *offer* too so non-TTY runs print a hint instead
   of silently skipping).
2. In `handler.ts`, after the scaffold succeeds, when interactive:
   - `promptYesNo("Add authentication (sign-up / sign-in)?")` → on yes,
     `promptSelect` the provider (email + password [default] / Clerk / Auth0) and
     apply `auth` (or `auth-clerk` / `auth-auth0`) into the new project dir.
   - `promptYesNo("Add transactional email?")` → on yes, apply `mail`. If plan
     011 has landed, also `promptYesNo("Capture email in the studio in dev?",
     defaultYes)` and set the capture flag the mail registry item reads.
   - Print the applied items + each item's `docs` hint at the end.
3. Non-interactive / `--yes`: skip the prompts; print a one-line hint that
   `cirrus add auth` / `cirrus add email` can set these up later. (`--yes` could
   alternatively mean "accept defaults = add nothing"; choose "add nothing" so
   `--yes` stays safe for scripts.)

**Verify**: `pnpm --filter "@cirrus/cli" run test` incl. a new test that runs init
non-interactively (no prompts, hint printed) and one that simulates "yes to auth"
and asserts the `auth` item was applied (deps in `package.json`, binding in
`wrangler.jsonc`, `cirrus/auth/index.ts` written).

### Step 4 — `cirrus add <feature>`

1. New command `packages/cli/src/commands/add/` (`index.ts` metadata + `handler.ts`).
   `cirrus add auth` and `cirrus add email` (alias `mail`). Validate it is run
   inside a Cirrus project (a `wrangler.jsonc` + `cirrus/` present); error
   helpfully otherwise.
2. Prompt the same follow-ups as Step 3 (provider for auth; capture-in-dev for
   email), then call the registry apply function. Support `--yes` for the
   default provider with no prompts. Print the `docs` hint.
3. Register the command in the CLI command list (find where `init`/`registry` are
   registered — likely `packages/cli/src/index.ts` or a command table) following
   the file's named-export + `loader` convention (CLAUDE.md: adapt at the call
   site, no mixed default+named).

**Verify**: `pnpm --filter "@cirrus/cli" run test` incl. a test that `cirrus add
auth` in a fixture project applies the item; `cirrus add` outside a project errors
cleanly; `lint:types` + `lint:eslint` 0.

### Step 5 — Docs

Update the CLI command reference (wherever `init`/`registry` are documented) to
list `cirrus add` and the new `init -i` behavior. Keep the registry docs as the
source of truth for what each item installs.

## Test plan

- `@cirrus/config`: `promptSelect` returns the chosen value interactively and the
  default/undefined non-interactively.
- `@cirrus/cli`: init non-interactive prints the hint and applies nothing; init
  "yes to auth" applies `auth`; `cirrus add email` applies `mail`; `cirrus add`
  outside a project errors; `--yes` adds nothing in init and uses defaults in
  `add`.
- No regression in existing registry/init tests.

## Done criteria

- [ ] `cirrus init -i` (TTY) offers auth + email and applies the chosen registry
      item(s) into the new project; non-TTY/`--yes` never hangs and prints a hint.
- [ ] `cirrus add auth` / `cirrus add email` apply the matching registry item to
      an existing project, with provider/capture follow-ups.
- [ ] Both flows call the **existing** registry apply function — no duplicated
      binding/`.dev.vars`/file logic.
- [ ] The email flow scaffolds the **Cloudflare** default (+ dev catcher when
      plan 011 is present), not Resend-by-default.
- [ ] `pnpm --filter "@cirrus/cli" run test` and `… "@cirrus/config" run test`
      pass; touched packages `lint:types` + `lint:eslint` clean.

## STOP conditions

- The registry apply function cannot be invoked against a freshly-scaffolded dir
  without changing the apply pipeline — STOP and report (the pipeline is
  out of scope).
- Applying `auth`/`mail` requires bindings the fresh template's `wrangler.jsonc`
  can't accept (e.g. reconciliation throws) — STOP; this is a registry/template
  contract issue to surface, not to paper over.
- A prompt could block in CI / non-TTY despite the `isInteractive()` gate — STOP;
  prompting must never hang automation.

## Maintenance notes

- New registry items get these front doors for free once they exist — extend the
  `add` feature map (and the init offer, if first-class enough) rather than adding
  bespoke commands.
- If/when `cirrus init` grows a full "stack picker", this offer is the seam to
  build it on; keep the registry as the single install path.
