# Cirrus Agent Skills

First-party [Agent Skills](https://tanstack.com/intent/latest/docs/registry) for
Cirrus — portable instructions that teach AI coding agents how to use the
framework correctly. They ship inside `@cirrus/cli` and are discovered by the
[TanStack Intent registry](https://tanstack.com/intent/registry) via the
`tanstack-intent` package keyword.

Each skill is a `SKILL.md` with YAML frontmatter (`name`, `description`) in its
own directory:

| Skill                      | Use for                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `cirrus`                   | Router — start here, then switch to the matching skill below. |
| `cirrus-quickstart`        | `cirrus init` / adding Cirrus to an app + first round-trip.   |
| `cirrus-setup-auth`        | Authentication via `cirrus registry add auth` (+ providers).  |
| `cirrus-create-package`    | Building a reusable registry item or `@cirrus/*` package.     |
| `cirrus-migration-helper`  | Schema/data migrations, `.global()` D1 flow, the drift gate.  |
| `cirrus-performance-audit` | Scans, indexes, OCC write conflicts, sharding/`.global()`.    |

These are mirrored into `.agents/skills/` and `.claude/skills/` (via symlinks)
so agents working inside this repo pick them up directly. The source of truth
lives here so the published `@cirrus/cli` tarball carries them.
