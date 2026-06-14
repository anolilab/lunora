# Plan 018: Add agent skills for the core installable capabilities

> **Executor instructions**: Follow step by step; verify each new skill against
> the package's real API before writing it; obey STOP conditions; update
> `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/cli/skills/`
> If new skills already exist for the targets below, reconcile (don't duplicate).

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: LOW (new docs; no code paths change)
- **Depends on**: none (plan 017 will link these once they exist)
- **Category**: dx / docs
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

Cirrus ships 9 agent skills but ~9 installable capabilities have none
(`mail`, `storage`, `scheduler`, `ratelimit`, `vectors`, `ai`, `container`,
`mcp`, `payment`). Agents asking "how do I send mail / store files / schedule a
job in Cirrus" have no guided, API-correct instructions and must reverse-engineer
from source. This plan adds the highest-value capability skills, each verified
against the actual package API. To keep scope executable and accuracy high, it
targets the three most commonly-needed registry capabilities first; the rest are
explicit follow-ups.

## Current state

- `packages/cli/skills/` contains: `cirrus`, `cirrus-quickstart`,
  `cirrus-functions`, `cirrus-realtime`, `cirrus-setup-auth`,
  `cirrus-create-package`, `cirrus-migration-helper`, `cirrus-deploy`,
  `cirrus-performance-audit`. Each is `<name>/SKILL.md` with YAML frontmatter
  (`name`, `description`).
- **Exemplar to copy structure/tone from**: `packages/cli/skills/cirrus-setup-auth/SKILL.md`
  (frontmatter → "When to Use" / "When Not to Use" → install step → API usage →
  checklist). Read it fully before writing.
- `packages/cli/skills/README.md` has a table listing every skill — new skills
  must be added there.
- The skills are mirrored into `.agents/skills/` and `.claude/skills/` via
  symlinks (per `README.md`); confirm whether new directories need a matching
  symlink or are picked up automatically (`ls -la .claude/skills | head`).

## Target capabilities (this plan)

1. `cirrus-setup-mail` → `@cirrus/mail` (Resend adapter, TSX templates,
   queue-backed sends). Source of truth: `packages/mail/src` + `packages/mail/README.md` if present.
2. `cirrus-setup-storage` → `@cirrus/storage` (R2 typed buckets, signed URLs).
   Source: `packages/storage/src`.
3. `cirrus-setup-scheduler` → `@cirrus/scheduler` (`runAfter`/`runAt`, cron via
   `SchedulerDO`). Source: `packages/scheduler/src`.

(Deferred follow-ups, not this plan: `ai`, `ratelimit`, `vectors`, `container`,
`mcp`, `payment`.)

## Commands

| Purpose           | Command                                               | Expected            |
| ----------------- | ----------------------------------------------------- | ------------------- |
| Markdown format   | `pnpm run lint:prettier`                              | exit 0 / unaffected |
| Verify API claims | read `packages/<pkg>/src/index.ts` and exported types | —                   |

## Scope

**In scope**: three new `packages/cli/skills/<name>/SKILL.md` files; an update to
`packages/cli/skills/README.md`'s table; symlink additions if required.
**Out of scope**: any source code; the deferred capabilities; changing existing
skills (plan 017 handles router links).

## Steps

### Step 1: For EACH target, extract the real API first

Before writing a word of guidance, read the package's `src/index.ts` (and the
public types it exports) and any README. Write down: the exact install command
(`cirrus registry add <item>` — confirm the item name from the registry, e.g.
look in `registry/` or run `cirrus registry list` conventions), the exact import
paths, the exact exported functions/options, and how it wires into `ctx`
(codegen-wired? a binding?). **If the public API is ambiguous from the source,
STOP and report rather than guessing** — a wrong skill is worse than no skill.

### Step 2: Write each SKILL.md modeled on `cirrus-setup-auth`

For each capability, create `packages/cli/skills/<name>/SKILL.md` with:

- YAML frontmatter: `name: <name>` and a `description` that says when to use it
  (this string drives skill selection — make it specific, mirror the style of
  existing descriptions).
- "When to Use" / "When Not to Use".
- Install step (`cirrus registry add <item>`), required bindings/env (cite real
  binding names from the package/wrangler expectations), the `cirrus codegen`
  step if the capability is codegen-wired.
- A minimal, **compilable** usage example using the real exports (no `.js` import
  extensions; correct `@cirrus/*` paths).
- A short checklist.

Every API claim must trace to the source you read in Step 1.

### Step 3: Register the new skills

- Add a row per new skill to `packages/cli/skills/README.md`'s table.
- If `.claude/skills` / `.agents/skills` use per-skill symlinks, add matching
  links so they're discoverable in-repo (match how existing skills are linked).

### Step 4: Sanity-check

- `pnpm run lint:prettier` passes (or is unaffected) on the new Markdown.
- Re-read each example and confirm imports/exports match the source.

## Done criteria

- [ ] `cirrus-setup-mail`, `cirrus-setup-storage`, `cirrus-setup-scheduler`
      exist with frontmatter + verified, compilable examples
- [ ] `packages/cli/skills/README.md` table lists them
- [ ] Symlinks (if the repo uses them) added so the skills resolve in-repo
- [ ] No API claim contradicts the package source
- [ ] `git status` shows only skill files + README (+ symlinks)
- [ ] `plans/README.md` updated

## STOP conditions

- A target package's public API is ambiguous/unstable enough that you cannot
  write accurate guidance — report which and skip it (a partial, correct set
  beats a complete, wrong one).
- The registry item name for a capability cannot be confirmed from the repo.

## Maintenance notes

- Follow-up: add skills for `ai`, `ratelimit`, `vectors`, `container`, `mcp`,
  `payment` once these three are validated in use.
- After this lands, update plan 017's router bullet to name the new skills.
- Keep each skill's `description` accurate — it is what makes the right skill get
  selected.
