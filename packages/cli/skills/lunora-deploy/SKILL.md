---
name: lunora-deploy
description: Deploys a Lunora app to Cloudflare Workers + Durable Objects and gets wrangler.jsonc, remote resources and secrets to line up. Covers `lunora deploy` (and `--env`, `--dry-run`, `--preview`, `--migrate`), the `lunora doctor` / `lunora verify` / `lunora prepare` preflights, Durable Object bindings (SHARD, SHARD_REGISTRY, SCHEDULER), the `DB` D1 binding and its placeholder id, R2 buckets, production secrets (`lunora env push`, `wrangler secret put`) versus `.dev.vars`, the schema-drift gate, the architecture diff, and rollback with `lunora deployments`. Use when the user asks to "deploy", "ship to production", "set up a staging environment", wire CI deploys, or when a deploy fails on a binding, a placeholder `database_id`, an unexported Durable Object class, a missing secret, or "schema drift gate blocked deploy".
---

# Lunora Deploy

Deploying a Lunora app means making `wrangler.jsonc`, the remote Cloudflare
resources (D1, R2, secrets) and the worker's exports agree. `lunora deploy`
automates most of that and refuses to ship when they don't.

Local development is `lunora dev` (see `lunora-quickstart`). If the deploy is
blocked by a breaking schema change, stage it with `lunora-migration-helper`
first.

## What `lunora deploy` does

In order, stopping at the first failure:

1. **Codegen** — regenerates `lunora/_generated/`. ERROR-level codegen
   advisories fail the deploy in CI (`--strict-advisories` forces this locally,
   `--no-strict-advisories` turns it off). Nothing here runs `tsc` and wrangler
   strips types, so a project with a type error deploys — gate CI on
   `lunora verify`, which does type-check.
2. **Schema-drift gate** — compares the schema with the committed baseline
   `lunora/.lunora-schema.json` (details below).
3. **Architecture diff** — prints modules and edges (calls, table reads/writes,
   enqueues) added or removed since the last successful deploy. Informational
   only; the manifest is recorded in `.lunora/architecture[.<env>].json` after
   wrangler succeeds.
4. **Binding reconcile** — writes the bindings the code implies into
   `wrangler.jsonc`: Durable Object bindings plus their `new_sqlite_classes`
   migration, the `DB` D1 binding for `.global()` tables, crons, and the
   compatibility date. R2 buckets are not auto-written (the bucket name is
   yours to choose); you get a warning instead.
5. **Read-only checks** — blocks on a D1 `database_id` still set to
   `<replace-with-d1-create-id>`, on a loopback URL (`localhost`, `127.x`,
   `::1`) in `vars`, on a missing container Dockerfile, or on no Docker engine
   when a container builds locally.
6. **Validate `wrangler.jsonc`** — the `SHARD` binding to `ShardDO` (or
   `LunoraDO` for apps that merge their DOs), a minimum `compatibility_date`,
   DO classes registered in `migrations`, and the shape of every binding.
   `compatibility_flags` are not checked; templates ship `nodejs_compat` for
   dependencies that import `node:` builtins.
7. **Secrets gate** — lists the secrets the app's packages need and checks
   which are set on the worker. Interactive runs offer to mint and push the
   generatable ones (`BETTER_AUTH_SECRET`, `LUNORA_ADMIN_TOKEN`, …). In CI a
   missing required secret aborts the deploy. Skipped for `--dry-run` /
   `--preview`, and when the worker doesn't exist yet.
8. **Services, then `wrangler deploy`** — services declared in
   `lunora.config` deploy first (`--skip-services` to skip), then the app.
9. **After a successful deploy** — records the URL as the project link
   (`lunora link`), optionally runs `--migrate` and `--health-check`, and only
   then re-blesses the schema baseline.

`lunora prepare` runs steps 1–6 without deploying (useful in CI), but it takes
no `--env`, so it validates the top-level config only. `lunora verify` runs
validation, a codegen dry run and `tsc --noEmit` without writing files, and does
take `--env`.

Flags worth knowing:

| Flag                       | Effect                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `--env <name>`             | Deploy a wrangler environment; checks read that env's (non-inherited) bindings. |
| `--dry-run`                | Run every gate and bundle without publishing; `wrangler.jsonc` edits roll back. |
| `--preview`                | Upload a version (`wrangler versions upload`) with a preview URL; no traffic.   |
| `--health-check`           | Probe `/_lunora/health/ready` on the new version; fail if it never answers.     |
| `--prebuilt`               | Skip codegen and the drift gate when `lunora prepare` already ran in this job.  |
| `--migrate`                | Run every declared data migration (`up` is idempotent) against the live worker. |
| `--allow-schema-drift`     | Deploy despite blocked drift; the baseline is not advanced.                     |
| `--update-schema-baseline` | Accept the current schema as the new baseline.                                  |

`--migrate` is checked before wrangler runs, so a missing requirement aborts the
whole deploy:

- `--migrate-yes` — confirms running production data migrations.
- `--migrate-url <https://…>` — required unless this checkout is linked for the
  same `--env` (a previous successful deploy links it automatically).
- An admin token — `--migrate-token` or `LUNORA_ADMIN_TOKEN`.

```bash
lunora deploy --migrate --migrate-yes --migrate-url https://app.example.com
```

## Preflight

```bash
lunora doctor                 # read-only; exits 1 on any FAIL, WARN/INFO don't block
lunora doctor --format json   # each finding carries a stable `code` for CI/agents
lunora verify --env production
```

`lunora doctor` fails on a missing or invalid `wrangler.jsonc`, a missing
`SHARD` binding, a placeholder D1 id (`d1-placeholder-id`), and a binding whose
class the worker doesn't export (`wrangler-class-unexported`), and an Artifacts
namespace in the wrong jurisdiction. It warns on unfilled `.dev.vars` secrets,
placeholder `send_email` destinations, an account near its Durable Object class
cap, and a `cloudflare.config.ts` (`cf-config-present`).

## `wrangler.jsonc`

Templates ship this shape. The `d1_databases` and `r2_buckets` entries are
only needed when the app uses `.global()` tables or auth (D1) and storage (R2):

```jsonc
{
    "name": "my-app",
    "main": "src/server.ts",
    "compatibility_date": "2026-10-01",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [
            { "name": "SHARD", "class_name": "ShardDO" },
            { "name": "SHARD_REGISTRY", "class_name": "ShardRegistryDO" },
        ],
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "ShardRegistryDO"] }],
    "limits": { "cpu_ms": 30000 },
    "d1_databases": [{ "binding": "DB", "database_name": "my-app", "database_id": "<replace-with-d1-create-id>" }],
    "r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "my-app-uploads" }],
}
```

Reconcile adds `SCHEDULER` → `SchedulerDO` when the app schedules work, and
bindings for generated containers, workflows and agents. Every `class_name`
must be exported by the worker entry or wrangler rejects the deploy.

Lunora writes the bindings but cannot create the remote resources:

```bash
wrangler d1 create my-app              # paste the returned database_id into wrangler.jsonc
wrangler r2 bucket create my-app-uploads
```

When using `--env`, remember that `vars`, `d1_databases`, `durable_objects` and
`containers` do not inherit in wrangler. Each environment needs its own entries,
including its own D1 database.

## Secrets

`.dev.vars` is for development only: it is git-ignored and `wrangler deploy`
never uploads it. Production secrets live in Cloudflare:

```bash
lunora env diff --env production        # keys local-only vs set remotely
lunora env push --env production --yes  # uploads .dev.vars values; refuses placeholders
wrangler secret put RESEND_API_KEY --env production   # set a prod-only value by hand
```

`lunora env push` uploads the values from `.dev.vars`. If production needs
different values than dev (it usually does for provider keys), set those with
`wrangler secret put` instead.

## Schema-drift gate

The gate blocks when the schema changed in a breaking way since
`lunora/.lunora-schema.json` and no new `defineMigration` on the affected table
covers it. The block message lists each change and a paste-ready
`lunora migrate create … --table …` command. Commit the baseline file so CI
and every machine gate against the same shape. It is advanced only after a
successful deploy, so a failed deploy never moves it past a change that didn't
ship.

Reach for `--allow-schema-drift` / `--update-schema-baseline` only when you know
existing data is compatible. Otherwise stage the change with
`lunora-migration-helper`.

## `.global()` table DDL

The runtime provisions `.global()` tables itself on first use
(`CREATE TABLE IF NOT EXISTS` plus additive `ADD COLUMN` / indexes), so additive
changes need no step. `lunora migrate generate` writes a reviewable SQL file for
D1-backed global tables, but no command applies it, `lunora deploy` included.
Destructive or hand-written statements in it (drops, a backfilling `UPDATE`, a
rename) must be applied by hand:

```bash
wrangler d1 execute DB --remote --file=lunora/migrations/<file>.sql
```

See `lunora-migration-helper` for the full flow.

## Rollback

```bash
lunora deployments list
lunora deployments rollback --yes              # previous version
lunora deployments promote <version-id> --yes  # send 100% of traffic to a version
```

Rolling back code does not roll back data migrations or D1 DDL.

## Common pitfalls

1. **Placeholder `database_id`.** Reconcile writes
   `<replace-with-d1-create-id>`; deploy refuses it. Run `wrangler d1 create`
   and paste the id.
2. **DO class not exported.** Export `ShardDO` (and any generated container /
   workflow class) from the worker entry; `lunora doctor` names the gap.
3. **Secrets only in `.dev.vars`.** They never reach production. Push or
   `wrangler secret put` them before the first request.
4. **Dev and prod sharing resources.** Give each environment its own D1
   database, R2 buckets and secrets; never point a dev worker at prod data.
5. **Uncommitted schema baseline.** Commit `lunora/.lunora-schema.json` (and
   `lunora/migrations/.snapshot.json` if you use `migrate generate`).
   `lunora/_generated/` is regenerated by deploy; templates git-ignore it.
6. **Using `cf dev` / `cf build` / `cf deploy`.** They read
   `cloudflare.config.ts`, which Lunora never updates
   ([#964](https://github.com/anolilab/lunora/issues/964)). Use `lunora dev` /
   `lunora deploy`; `cf` resource commands (zones, DNS, KV) are fine.

## Checklist

- [ ] `lunora doctor` has no FAIL; `lunora verify --env <name>` passes in CI.
- [ ] D1 / R2 resources created per environment; real ids in `wrangler.jsonc`.
- [ ] Every DO / container / workflow `class_name` is exported by the worker entry.
- [ ] Production secrets set (`lunora env diff --env <name>` shows nothing local-only that prod needs).
- [ ] Breaking schema changes staged with a migration; drift gate green.
- [ ] `lunora deploy --env <name> --health-check` succeeded; `--migrate --migrate-yes` run if backfills were pending.
