# Plan 001: Make the CLI reference docs match the actual CLI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 491e6314..HEAD -- apps/docs/content/docs/api/cli.mdx apps/docs/content/docs/tutorial/realtime-chat.mdx packages/cli/src/commands/ packages/cli/src/cli.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Note: the two in-scope **docs**
> files are what you edit; the `packages/cli/` paths are read-only reference.)

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `491e6314`, 2026-06-11 (reconciled after the cerebro v3 CLI restructure)

## Why this matters

The public CLI reference page documents a `cirrus new` subcommand that no
longer exists (it was removed; the CLI has no `new.ts` command). It also lists
only 3 `cirrus init` templates when 8 exist, references a `plop-templates/`
directory that is gone, and omits roughly half of the commands the CLI actually
ships. A user following these docs gets "command not found" and a wrong mental
model of the tool. Stale docs are worse than missing docs.

## Current state

- `apps/docs/content/docs/api/cli.mdx` — the CLI reference page. Around lines
  15–25 it shows a command-overview code block that includes:

  ```
  cirrus new <kind> <name>            # scaffold query|mutation|action|table|package
  ```

  and around lines 35–58 a full `### \`cirrus new\`` section with a table of
  generators ("Scaffolds a Cirrus building block from a Plop template under
  `plop-templates/generators/`") and example invocations
  (`cirrus new query listMessages`, `cirrus new package telemetry …`).

  The `### \`cirrus init\`` section lists templates as only: `vite`,
  `standalone`, `next` ("not yet available — warns and exits").

- `apps/docs/content/docs/tutorial/realtime-chat.mdx` — the tutorial; also
  invokes `cirrus new` (grep confirms it is the only other page referencing it).

- `packages/cli/src/cli.ts` — **the authoritative command list.** It declares
  a `COMMANDS` string array (the canonical names) and imports a
  `<name>Command` object from each `./commands/<name>`. At planning time the
  `COMMANDS` array is exactly:

  ```ts
  const COMMANDS = [
      "init", "dev", "codegen", "deploy", "prepare", "logs", "run", "reset",
      "migrate", "export", "import", "backup", "verify", "info", "env",
      "analyze", "view", "docs", "registry",
  ] as const;
  ```

  There is **no** `new`. (Note the CLI grew since older docs: `export`,
  `import`, `backup`, `prepare`, `analyze`, `view`, `info`, `env`, `migrate`,
  `registry` all exist now.)

- `packages/cli/src/commands/<name>/` — the cerebro v3 lazy command structure
  (a recent refactor moved each command from a flat `<name>.ts` into a
  directory). Each `commands/<name>/index.ts` exports `<name>Command` with the
  user-facing metadata; `commands/<name>/handler.ts` holds the logic. **Read
  the `index.ts`, not the handler** — it carries `description`, `group`, and
  `options` (each option has a `name` + `description`). Example shape from
  `commands/verify/index.ts`:

  ```ts
  const verifyCommand: Command = {
      description: "Validate wrangler.jsonc + codegen dry-run + tsc --noEmit (no files written)",
      group: "Deploy",
      loader: () => import("./handler").then(...),
      name: "verify",
      options: [
          { description: "Which API spec(s) to emit: …", name: "api-spec", type: String },
          { description: "Skip the TypeScript type-check step", name: "no-typecheck", type: Boolean },
      ],
  };
  ```

  A few commands may still be a flat `<name>.ts` (e.g. `data-transfer.ts`) or
  register from a non-`index.ts` file (e.g. `registry/command.ts`) — trust the
  imports in `cli.ts` to find each command's definition file.

- `templates/` — the authoritative `cirrus init` template list. Directories at
  planning time: `astro, nuxt, react-router, solid-start, standalone,
  sveltekit, tanstack-start, vite`. Cross-check against how
  `packages/cli/src/commands/init.ts` resolves `-t` before writing the list.

**Critical nuance — what replaced `cirrus new`:** nothing user-facing. Per the
repo's `CLAUDE.md` ("Internal scaffolding (`vis generate`)" section), the
`vis generate cirrus-*` generators are **internal to this monorepo** — end
users of a Cirrus app do not have `vis` and must not be told to use it. The
correct docs fix is to *remove* the `cirrus new` material and, where the
tutorial relied on it, show the file being created by hand (the generated
content was always a small `query({ args, handler })` / `mutation({...})`
file in `cirrus/`). Do NOT document `vis generate` as the replacement in
end-user docs.

- Repo conventions: docs are `.mdx` (fumadocs). Prettier formats Markdown
  (`pnpm lint:prettier`). Match the heading/code-block style already used in
  `cli.mdx`.

## Commands you will need

| Purpose          | Command                                                       | Expected on success            |
| ---------------- | ------------------------------------------------------------- | ------------------------------ |
| Install          | `pnpm install`                                                | exit 0                         |
| Stale refs check | `grep -rn "cirrus new" apps/docs/content`                     | no matches (after the fix)     |
| Plop refs check  | `grep -rn "plop" apps/docs/content/docs/api/cli.mdx`          | no matches (after the fix)     |
| Format           | `pnpm exec prettier --check apps/docs/content/docs/api/cli.mdx apps/docs/content/docs/tutorial/realtime-chat.mdx` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `apps/docs/content/docs/api/cli.mdx`
- `apps/docs/content/docs/tutorial/realtime-chat.mdx`

**Out of scope** (do NOT touch, even though they look related):

- `packages/cli/src/**` — the CLI itself is correct; only docs are wrong.
- `CLAUDE.md` / `AGENTS.md` — already accurate.
- Any other docs page (run the grep first; at planning time only the two
  in-scope pages referenced `cirrus new`).
- `packages/cli/src/commands/**` (including `deploy/`) — describe each command
  from its `index.ts` metadata, but never modify CLI source.

## Git workflow

- Branch: `docs/cli-reference-accuracy` off `alpha`.
- Commit style: conventional commits, e.g. `docs(cli): remove removed cirrus-new docs and sync command reference` (subject ≤ 50 chars; imperative; lowercase).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Build the authoritative command inventory

Open `packages/cli/src/cli.ts` and read the `COMMANDS` array — that is the
exact set of registered command names. For each name, open its definition file
(follow the matching `import { <name>Command } from "./commands/<name>"` in
`cli.ts`; that resolves to `commands/<name>/index.ts` for most commands) and
record: the command `name`, its one-line `description`, and its `options`
(each option's `name` + `description`). Read `index.ts`, not `handler.ts`.

**Verify**: you have a written list (in your scratch notes) of every name in
`COMMANDS` with its description and flags; `cirrus new` is not among them, and
your list length equals the `COMMANDS` array length.

### Step 2: Rewrite the command-overview block in `cli.mdx`

Replace the overview code block near the top of
`apps/docs/content/docs/api/cli.mdx` so it lists exactly the registered
commands from Step 1, one line each with their primary flags, in the existing
visual style. Delete the `cirrus new` line.

**Verify**: `grep -n "cirrus new" apps/docs/content/docs/api/cli.mdx` → no matches.

### Step 3: Delete the `### \`cirrus new\`` section

Remove the whole section (the prose about Plop templates, the generators
table, and the example block). If the page's flow needs a bridge, add a short
note under the `cirrus/` directory explanation that queries/mutations/actions
are plain TypeScript files you create by hand, with one ~8-line example
`query({ args, handler })` file (model it on any `templates/*/cirrus/messages.ts`).

**Verify**: `grep -n "plop\|cirrus new" apps/docs/content/docs/api/cli.mdx` → no matches.

### Step 4: Fix the `cirrus init` template list

Update the `### \`cirrus init\``  section to list the real templates. Derive
the canonical names from the init command's handler
(`packages/cli/src/commands/init/handler.ts`, and its `index.ts` for the `-t`
option) — how `-t` values map to `templates/<dir>`; the directories at
planning time were:
`astro, nuxt, react-router, solid-start, standalone, sveltekit,
tanstack-start, vite`. Remove the stale `next — not yet available` entry
unless `init.ts` still special-cases it (check before deleting).

**Verify**: every template name in the docs list exists as a directory under
`templates/`; every directory under `templates/` appears in the docs list.

### Step 5: Fix the tutorial

In `apps/docs/content/docs/tutorial/realtime-chat.mdx`, replace each
`cirrus new …` invocation with explicit "create this file" instructions
showing the full file content the command used to generate (a small
`query`/`mutation` file in `cirrus/`, matching the shapes used elsewhere in
the same tutorial). Keep the tutorial's narrative flow intact — change only
the scaffolding instructions.

**Verify**: `grep -rn "cirrus new" apps/docs/content` → no matches.

### Step 6: Format

Run `pnpm exec prettier --write apps/docs/content/docs/api/cli.mdx apps/docs/content/docs/tutorial/realtime-chat.mdx`.

**Verify**: `pnpm exec prettier --check <both files>` → exit 0.

## Test plan

No unit tests apply (docs-only). Verification is the grep gates above plus,
optionally, a docs build if it runs cleanly in your environment:
`pnpm --filter docs run build` (if the filter name differs, find it in
`apps/docs/package.json` `name` field). If the docs build fails for reasons
unrelated to these two files, note it and continue — it is not a gate.

## Done criteria

- [ ] `grep -rn "cirrus new" apps/docs/content` returns no matches
- [ ] `grep -n "plop" apps/docs/content/docs/api/cli.mdx` returns no matches
- [ ] Every command in `cli.mdx`'s overview block exists in `packages/cli/src/cli.ts` registration, and vice versa
- [ ] Template list in `cli.mdx` matches `templates/` directories
- [ ] `pnpm exec prettier --check` on both files exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `packages/cli/src/cli.ts` has no `COMMANDS` array, or it registers commands
  from somewhere you cannot trace to a definition file with a `description` —
  you cannot determine the real command set.
- The command set in `COMMANDS` differs by more than ~3 names from the
  inventory in "Current state" (drifted further since reconcile) — re-scope.
- The tutorial's `cirrus new` usages generate content you cannot reconstruct
  from the templates or surrounding tutorial text.

## Maintenance notes

- Any new CLI command or template needs a matching docs edit; consider (out of
  scope here) a future test that diffs `cli.ts` registrations against the
  docs page.
- Reviewer should spot-check 2–3 command descriptions against `--help` output.
