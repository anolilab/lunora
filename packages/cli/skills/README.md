# Lunora Agent Skills

First-party [Agent Skills](https://tanstack.com/intent/latest/docs/registry) for
Lunora — portable instructions that teach AI coding agents how to use the
framework correctly. They ship inside `@lunora/cli` and are discovered by the
[TanStack Intent registry](https://tanstack.com/intent/registry) via the
`tanstack-intent` package keyword.

Each skill is a `SKILL.md` with YAML frontmatter (`name`, `description`) in its
own directory:

| Skill                      | Use for                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `lunora`                   | Router — start here, then switch to the matching skill below.               |
| `lunora-quickstart`        | `lunora init` / adding Lunora to an app + first round-trip.                 |
| `lunora-functions`         | Core authoring rules — schema, validators, query/mutation/action, `ctx.db`. |
| `lunora-realtime`          | Client reactivity — live hooks, optimistic updates, `@lunora/db`.           |
| `lunora-setup-auth`        | Authentication via `lunora registry add auth` (+ providers).                |
| `lunora-setup-mail`        | Transactional email via `lunora registry add mail` — `sendEmail` actions.   |
| `lunora-setup-storage`     | R2 file storage via `lunora registry add storage` — signed upload/download. |
| `lunora-setup-scheduler`   | Deferred (`ctx.scheduler`) + cron jobs (`lunora registry add crons`).       |
| `lunora-create-package`    | Building a reusable registry item or `@lunora/*` package.                   |
| `lunora-migration-helper`  | Schema/data migrations, `.global()` D1 flow, the drift gate.                |
| `lunora-deploy`            | Deploying to Cloudflare — wrangler bindings, secrets, the gate.             |
| `lunora-performance-audit` | Scans, indexes, OCC write conflicts, sharding/`.global()`.                  |

These are mirrored into `.agents/skills/` and `.claude/skills/` (via symlinks)
so agents working inside this repo pick them up directly. The source of truth
lives here so the published `@lunora/cli` tarball carries them.
