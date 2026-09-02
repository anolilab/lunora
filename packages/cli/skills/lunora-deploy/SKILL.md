---
name: lunora-deploy
description: Deploys a Lunora app to Cloudflare. Use for `lunora deploy`, wrangler.jsonc
    bindings (SHARD/SESSION DOs, D1, R2), provisioning databases/buckets, secrets
    (`wrangler secret` vs `.dev.vars`), the `lunora doctor` preflight, the
    schema-drift gate, and dev-vs-prod separation.
---

# Lunora Deploy

Ship a Lunora app to Cloudflare Workers + Durable Objects. Unlike a managed
backend, deployment owns real Cloudflare resources — Durable Object bindings, a
D1 database, R2 buckets, and secrets — so the work is mostly making
`wrangler.jsonc` and the remote resources line up.

## When to Use

- Deploying to production (or a Cloudflare environment) for the first time.
- A deploy fails on a binding, a placeholder id, or the schema-drift gate.
- Provisioning D1 / R2 / secrets for a Lunora app.

## When Not to Use

- Local development — that is `lunora dev` (see `lunora-quickstart`).
- A schema/data change that needs migrating — do that first with
  `lunora-migration-helper`, then deploy.

## What `lunora deploy` Does

`lunora deploy` runs a fixed pipeline:

1. **Codegen** — regenerates `lunora/_generated/`. It does **not** run
   `tsc`: nothing in the deploy pipeline type-checks, and wrangler/esbuild
   strips types, so a project with a TS error deploys. Run `lunora verify`
   (which does run `tsc --noEmit`) as the CI type gate before this.
2. **Validate `wrangler.jsonc`** — a `compatibility_date` at or past the
   minimum the runtime needs, the `SHARD` Durable Object binding and its
   SQLite migration tag, and the shape of every declared binding. It does
   **not** check `compatibility_flags`: `nodejs_compat` is what every
   template ships and what dependencies reaching for `node:` builtins need,
   but no Lunora package requires it, so nothing fails when it is missing.
3. **Schema-drift gate** — blocks if the committed baseline
   (`lunora/.lunora-schema.json`) drifted with a breaking change and no
   accompanying migration. The baseline is re-blessed only after the deploy
   succeeds.
4. **`wrangler deploy`** — builds and pushes the worker (and any container
   images).

Useful flags: `--env <name>` (Cloudflare environment), `--migrate` (run pending
data migrations against the live worker after deploy), `--allow-schema-drift`
(override the gate — use sparingly), and `--update-schema-baseline` (re-bless
the baseline with the current shape).

`--migrate` has three hard requirements, checked **before** `wrangler deploy`,
so missing one aborts the whole deploy rather than skipping the migration:

- `--migrate-yes` — confirms running production data migrations. Always
  required; there is no environment variable for it.
- `--migrate-url <https://…>` — the deploy target URL is only known after
  wrangler runs, so it cannot be inferred. Omit it only when the checkout is
  linked (`lunora link`) for this same `--env`.
- an admin token — `--migrate-token` or `LUNORA_ADMIN_TOKEN`.

```bash
lunora deploy --migrate --migrate-yes --migrate-url https://app.example.com
```

## Preflight: `lunora doctor`

Run the read-only preflight before deploying. It checks:

- `wrangler.jsonc` present with the `SHARD` durable-object binding.
- D1 `database_id`s are real, not placeholders (`<replace>` / empty).
- `send_email` destination addresses aren't placeholders.
- `.dev.vars` secret-looking keys are filled.
- Declared containers are exported by the worker entry.

```bash
lunora doctor   # FAIL → exit 1; WARN/INFO don't block
```

`lunora verify` and `lunora prepare` run related checks (drift gate, wrangler
validation) — wire `lunora verify` into CI to catch drift before a deploy.

## `wrangler.jsonc` — the binding contract

A Lunora worker needs the ShardDO (and SessionDO when auth is wired), the
SQLite-DO migration tag, and whatever D1/R2 the app uses:

```jsonc
{
    "name": "my-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [
            { "name": "SHARD", "class_name": "ShardDO" },
            { "name": "SESSION", "class_name": "SessionDO" }, // only with @lunora/auth
        ],
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SessionDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "my-app-global", "database_id": "<replace>" }],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "my-app-files" }],
}
```

`lunora dev` auto-reconciles most of this (and `lunora registry add` adds the
bindings an item needs), but the **resources themselves** must exist and their
ids must be filled in:

```bash
wrangler d1 create my-app-global   # paste the returned database_id into wrangler.jsonc
wrangler r2 bucket create my-app-files
```

The DO `class_name`s must be exported by your worker entry (the
`createShardDO()` / generated container exports) — wrangler rejects a binding
whose class the worker doesn't export. `lunora doctor` surfaces a missing
container export proactively.

## Secrets: `wrangler secret`, not `.dev.vars`

`.dev.vars` is **dev only** — it is git-ignored and never deployed. Production
secrets (`BETTER_AUTH_SECRET`, `RESEND_API_KEY`, provider client secrets, …) go
into Cloudflare:

```bash
wrangler secret put BETTER_AUTH_SECRET   # prompts for the value, stored encrypted
wrangler secret list
```

Set every secret your app reads (mirror the secret-looking keys in `.dev.vars`)
before the first request hits production.

## Dev vs Production

- **Development:** `lunora dev` (Vite + workerd + Studio + codegen-on-save). The
  schema baseline and `.dev.vars` belong to dev.
- **Production:** `lunora deploy`. Separate D1 database / R2 buckets / secrets
  from dev. Never point a dev worker at prod resources.

For `.global()` table DDL, `lunora migrate generate` emits a reviewable SQL
file — but **no command applies it**, `lunora deploy` included. What actually
provisions a global table is the runtime, from the schema rather than from the
file: on first use it runs `CREATE TABLE IF NOT EXISTS` plus additive
`ADD COLUMN`, so additive changes land whether or not the file exists.
Anything the generator cannot express — a backfilling `UPDATE`, a rename
written as add/copy/drop, an index the schema does not declare — must be
applied by hand:
`wrangler d1 execute <DB> --remote --file=lunora/migrations/<file>.sql`.
For data backfills, deploy first, then `lunora deploy --migrate --migrate-yes
--migrate-url <url>` (or `lunora migrate up --prod`). See
`lunora-migration-helper`.

## Common Pitfalls

1. **Placeholder `database_id`.** The D1 binding ships with `<replace>`; run
   `wrangler d1 create` and paste the id. `lunora doctor` catches this.
2. **DO class not exported.** `wrangler deploy` fails if a `class_name` isn't
   exported by the worker entry — export `ShardDO`/`SessionDO`/generated
   containers.
3. **Secrets only in `.dev.vars`.** They never reach production; use `wrangler
secret put` for every prod secret.
4. **Bypassing the drift gate.** `--allow-schema-drift` ships a breaking schema
   with no migration — stage the change (`lunora-migration-helper`) instead.
5. **Deploying with uncommitted codegen.** Commit `lunora/_generated/` and
   `lunora/.lunora-schema.json` so CI and the gate see the same baseline.

## Checklist

- [ ] `lunora doctor` passes (no FAIL).
- [ ] `wrangler.jsonc` has `compatibility_date`, `nodejs_compat`, the `SHARD` DO
      binding, and the SQLite migration tag.
- [ ] D1 / R2 resources created; real ids pasted into `wrangler.jsonc`.
- [ ] DO + container `class_name`s exported by the worker entry.
- [ ] Production secrets set via `wrangler secret put`.
- [ ] Schema changes migrated; the drift gate is green (no `--allow-schema-drift`).
- [ ] `lunora deploy` succeeded; `--migrate --migrate-yes --migrate-url <url>` run
      if data backfills were pending.
