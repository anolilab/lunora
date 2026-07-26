# Lunora Agent Skills

First-party [Agent Skills](https://tanstack.com/intent/latest/docs/registry) for
Lunora — portable instructions that teach AI coding agents how to use the
framework correctly. They ship inside `@lunora/cli` and are discovered by the
[TanStack Intent registry](https://tanstack.com/intent/registry) via the
`tanstack-intent` package keyword.

Each skill is a `SKILL.md` with YAML frontmatter (`name`, `description`) in its
own directory:

| Skill                            | Use for                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `lunora`                         | Router — start here, then switch to the matching skill below.                |
| `lunora-quickstart`              | `lunora init` / adding Lunora to an app + first round-trip.                  |
| `lunora-functions`               | Core authoring rules — schema, validators, query/mutation/action, `ctx.db`.  |
| `lunora-realtime`                | Client reactivity — live hooks, optimistic updates, `@lunora/db`.            |
| `lunora-setup-auth`              | Authentication via `lunora registry add auth` (+ providers).                 |
| `lunora-setup-mail`              | Transactional email via `lunora registry add mail` — `sendEmail` actions.    |
| `lunora-setup-storage`           | R2 file storage via `lunora registry add storage` — signed upload/download.  |
| `lunora-setup-scheduler`         | Deferred (`ctx.scheduler`) + cron jobs (`lunora registry add crons`).        |
| `lunora-setup-hyperdrive`        | Existing Postgres/MySQL from an action — `ctx.sql`, non-reactive.            |
| `lunora-setup-hyperdrive-global` | Postgres/MySQL as a reactive `.global()` backend; D1 → Hyperdrive migration. |
| `lunora-create-package`          | Building a reusable registry item or `@lunora/*` package.                    |
| `lunora-migration-helper`        | Schema/data migrations, `.global()` DDL flow, the drift gate.                |
| `lunora-deploy`                  | Deploying to Cloudflare — wrangler bindings, secrets, the gate.              |
| `lunora-performance-audit`       | `lunora insights`, scans, indexes, OCC conflicts, sharding/`.global()`.      |

These are mirrored into `.agents/skills/` and `.claude/skills/` (via symlinks)
so agents working inside this repo pick them up directly. The source of truth
lives here so the published `@lunora/cli` tarball carries them.

**Adding a skill?** Create it here, then mirror it through both hops:

```bash
ln -s ../../packages/cli/skills/<name> .agents/skills/<name>
ln -s ../../.agents/skills/<name> .claude/skills/<name>
```

`scripts/check-skill-mirrors.js` (run on every `pnpm install`) fails if a mirror
is missing, dangling, or has become a real directory — a copied directory keeps
resolving while it silently drifts from the source, so it is treated as an
error rather than a warning.
