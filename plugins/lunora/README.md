# Lunora agent plugin

The first-party Lunora plugin for Claude Code and Codex. It ships two things:

| Component  | What it is                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| **Skills** | The 14 first-party skills from `packages/cli/skills/`, symlinked in — `lunora` routes, the rest do the work.    |
| **Hook**   | A `Stop` gate that re-runs `lunora verify` at turn end and blocks with the compiler's own errors when it fails. |

## Install

**Claude Code**

```bash
/plugin marketplace add anolilab/lunora
/plugin install lunora@lunora
```

**Codex** — search for `lunora` in the plugin directory, or add this repo as a
marketplace (`.agents/plugins/marketplace.json`).

**Neither** — `lunora rules install` copies the same skills into the project's
`.agents/skills/`, which Cursor, Copilot and Codex all read. That path gives you
the skills without the hook.

## MCP is a separate install, on purpose

The plugin declares **no** MCP server. `lunora mcp install` already owns that
job, and it makes two decisions a plugin manifest cannot express: it spawns the
_project's_ binary through the project's package manager (a plugin-level `npx`
would fetch whatever is newest on npm and point a mismatched CLI at this
project's `.lunora/dev.json`), and it deliberately refuses to write a
machine-wide `lunora` entry, because the stdio spec carries no `cwd` and one
global entry would serve whichever directory the editor happened to start in.
See the comments on `McpServerPlan` in `packages/cli/src/commands/mcp/install.ts`.

```bash
lunora mcp install          # every MCP client configured on this machine
lunora mcp install --print  # show what it would write
```

## The `Stop` hook

`scripts/verify-turn.mjs` is the only new behaviour here. The skills already
say "run `lunora verify` before you call it done"; agents skip it, and the type
error surfaces on the user's next `lunora dev` instead of in the turn that
caused it. The hook makes the rule a mechanism: on turn end it runs the same
command and, on failure, blocks the stop with the output, so the next turn
starts from the real errors.

It stays quiet unless it has something to say:

- No `lunora/` directory **next to a wrangler config** → not a Lunora project,
  exit. The walk up stops at the enclosing `.git`, so a sibling checkout named
  `lunora` can't capture an unrelated repo.
- `git status --porcelain -- lunora` clean → the turn didn't touch the backend,
  so skip without paying for a `tsc` run. Non-git projects always verify.
- `stop_hook_active` → Claude Code is already continuing because this hook
  blocked. It also caps a hook at 8 consecutive blocks, which is why there is no
  counter here to get wrong.
- No `lunora` in the project's (or a parent's) `node_modules/.bin` → an
  environment fact, not a type error.

A verify that times out or cannot be spawned returns a `systemMessage` rather
than a silent `{}`, so "could not check" never reads as "checked, and it
passed".

```bash
node --test plugins/lunora/scripts/verify-turn.test.mjs   # also runs in postinstall
```

## Adding a skill

Skills are **not** authored here. `packages/cli/skills/<name>/` is the source of
truth; this directory holds symlinks, as do `.agents/skills/` and
`.claude/skills/`. See `packages/cli/skills/README.md` for the hops — or just
run `pnpm install`, and `scripts/check-skill-mirrors.js` prints the exact
`ln -s` command for whichever mirror is missing.

Claude Code dereferences symlinks that resolve inside the marketplace when it
copies a plugin into its cache, so installed users get file contents, not links.

## Not included, and why

- **A reviewer skill.** `lunora advisor` already runs the static and runtime
  lint set — RLS coverage, ownership checks, validators, index usage, secrets —
  and scores them per procedure. A markdown checklist restating a working linter
  is a checklist that drifts from it. The `lunora` router skill points at the
  command instead.
- **A runtime-error monitor.** Plugin monitors need something to tail, and
  `lunora dev` writes no error log. Add one when it does.
