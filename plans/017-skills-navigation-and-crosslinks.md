# Plan 017: Skills route to capabilities and clarify `.shardBy()` vs `.global()`

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done. Docs (SKILL.md) only.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/cli/skills/`
> Reconcile excerpts on change; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (docs only)
- **Depends on**: pairs with plan 018 (new capability skills) — if 018 lands
  first, link the new skills by name here; if not, link `cirrus registry list`.
- **Category**: dx / docs
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

The `cirrus` router skill's "Route to the Right Skill" list covers auth, schema,
realtime, migration, deploy, perf — but nothing for the installable capabilities
(`mail`, `storage`, `scheduler`, `ratelimit`, `vectors`, `ai`, `container`,
`mcp`, `payment`). An agent that needs one has no entry point. Separately, the
`.shardBy()` vs `.global()` trade-off is mentioned in two skills but never
compared in one place, so agents can't tell which to choose. Both are small,
high-leverage navigation fixes.

(Note: the often-cited "commit `cirrus/_generated/`" guidance already exists —
`packages/cli/skills/cirrus/SKILL.md:34`. Do NOT re-add it.)

## Current state

- `packages/cli/skills/cirrus/SKILL.md:40-59` — "Route to the Right Skill" list;
  no capability entry.
- `packages/cli/skills/cirrus-quickstart/SKILL.md:223-230` — "Next Steps"
  mentions `cirrus registry add <item>` but routes to no skill.
- `.shardBy()`/`.global()` appear in `cirrus-functions/SKILL.md` (the schema
  modifiers section, ~`:53-55`) and `cirrus-performance-audit/SKILL.md`
  (cross-region reads, ~`:112-116`) without a side-by-side comparison.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Markdown format check | `pnpm run lint:prettier` | exit 0 / unaffected |

## Scope

**In scope**: `packages/cli/skills/cirrus/SKILL.md`,
`packages/cli/skills/cirrus-quickstart/SKILL.md`,
`packages/cli/skills/cirrus-performance-audit/SKILL.md` (or `cirrus-functions`,
wherever the comparison fits best — pick one home and cross-reference).
**Out of scope**: creating new SKILL.md files (that's plan 018); rewriting skill
frontmatter `description`s; the symlink mirrors in `.agents/`/`.claude/`.

## Steps

### Step 1: Add a capability-routing entry to the router

In `cirrus/SKILL.md`'s "Route to the Right Skill" list, add a bullet:

```markdown
- Wiring a prebuilt capability (mail, file storage, scheduled jobs, rate
  limiting, vectors, AI, containers, payments, MCP): install it with
  `cirrus registry add <item>` (see `cirrus registry list`). For capabilities
  that have a dedicated skill, use it: <list the skills that exist — e.g.
  `cirrus-setup-mail`, `cirrus-setup-storage`, `cirrus-setup-scheduler` once
  plan 018 lands; otherwise read the item's README>.
```

If plan 018 has already added capability skills, name them; otherwise route to
`cirrus registry list` + the item README.

### Step 2: Cross-link from quickstart's Next Steps

In `cirrus-quickstart/SKILL.md` Next Steps (`:223-230`), make the
`cirrus registry add <item>` bullet point to the router's capability entry (or to
the specific capability skills if they exist).

### Step 3: One place comparing `.shardBy()` vs `.global()`

Add a short, factual comparison block (pick `cirrus-performance-audit` or
`cirrus-functions` as its home; cross-reference from the other):

```markdown
### `.shardBy(key)` vs `.global()` — choose one per table
- `.shardBy(key)`: partitions a table across Durable Objects by key — scales
  *writes* (e.g. messages per room). Reads are per-shard.
- `.global()`: replicates a table to D1 — scales *cross-region reads* with
  read-your-writes (e.g. a mostly-read catalog). 
- They are not combined on the same table; default (neither) is a single
  root-scoped ShardDO.
```

Verify these semantics against `CLAUDE.md` (Architecture Overview) and the
schema-modifier docs before writing — do not invent behavior.

## Done criteria

- [ ] Router lists a capability-routing entry
- [ ] Quickstart Next Steps links to it
- [ ] Exactly one skill carries the shardBy-vs-global comparison; the other
      cross-references it
- [ ] `git status` shows only SKILL.md files
- [ ] `plans/README.md` updated

## STOP conditions

- The cited skill sections no longer match the excerpts.
- The shardBy/global semantics you'd write contradict `CLAUDE.md` — reconcile or
  report rather than documenting something unverified.

## Maintenance notes

- When plan 018 adds capability skills, update the router bullet to name them.
- Keep the comparison in one place to avoid drift (the audit found duplicated
  text drifting elsewhere).
