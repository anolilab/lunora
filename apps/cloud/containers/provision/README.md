# The provision box

The container that turns a `ProvisionJob` into Cloudflare resources, by running
[Alchemy 2](https://alchemy.run) (`alchemy@2.0.0-beta.79`) against one cell's
account (`cloudflare-wfp`) or a customer's connected account
(`cloudflare-workers`). It replaces the hand-written REST provisioner (`src/provision.ts`,
`src/cloudflare/api.ts`).

Alchemy's engine is Node-shaped (rolldown, `fs`, a state store), so it cannot
run in the control-plane Worker; and it holds the cell's API token, so it cannot
share the build box, which runs untrusted tenant code. This box runs **trusted
code only**: `program.mjs` through the pinned Alchemy CLI. The tenant bundle and
assets are data it writes to disk and uploads, never imports or executes.

## Files

| File           | Role                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `server.mjs`   | HTTP surface. One job at a time; spawns the Alchemy CLI once per stack.                                       |
| `plan.mjs`     | Pure `ProvisionJob` → plan. All validation of tenant data. Unit-tested in `__tests__/provision-plan.test.ts`. |
| `program.mjs`  | The one Alchemy stack program. Static; reads the plan as JSON, never generated from tenant input.             |
| `package.json` | Pins `alchemy`, `effect`, `@effect/platform-node`. Installed from `package-lock.json` at image build.         |

Not a pnpm workspace member: the image installs its own lockfile.

## The contract

| Route                      | Purpose                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `POST /__lunora/provision` | Body is a `ProvisionJob` (JSON, `src/targets/provision-box/contract.ts`). Responds `200` NDJSON `ProvisionEvent`s. |
| `GET /__lunora/health`     | Readiness probe, `200 ok`.                                                                                         |

Responses to `POST /__lunora/provision`:

- `200 application/x-ndjson` — `{"type":"log","line"}` per line as Alchemy runs, then **exactly one** of
  `{"type":"result"}` or `{"type":"error","message"}`. `result` carries no `url`: a dispatch-namespace
  Worker has none of its own, the dispatcher routes to it. A job the box refuses (bad binding name,
  unsupported type, hostile asset path, …) is also a `200` whose only line is the `error`.
- `409` — another job is running on this instance.
- `400` — body is not JSON. `413` — body over 256 MiB.

Serves on `PORT`, default `8080`.

### One addition the job must carry

Every **provisioned** binding (`d1`, `kv`, `r2`, `queue_producer`, `analytics_engine`) must carry
`resourceName`, computed by the control plane with the contract's `tenantResourceName`:

```ts
bindings.map((b) => (BINDING_SUPPORT[b.type] === "provisioned" ? { ...b, resourceName: tenantResourceName(alias, b) } : b));
```

The box cannot import TypeScript from `src/`, and a second copy of the naming scheme would drift. It
refuses a provisioned binding without one, validates the charset, and refuses two bindings that map to
the same resource.

## What a job does

Every job names its `target` (`ProvisionTarget`):

- `dispatch-namespace` (`cloudflare-wfp`) — the cell's own account, with the box's own credentials. Stage = the
  dispatch namespace (`lunora-production`). Everything below describes this target unless it says otherwise.
- `account` (`cloudflare-workers`) — a customer's account, with the token the job carries. Stage =
  `account-<account id>`. The Worker is a plain Worker (no `namespace`) on the account's `workers.dev` subdomain
  (version preview URLs off), carries the release's `crons` itself, and consumes its own queues: each consumed
  producer queue gets a `Queues.Consumer` attached to the Worker, declared in the **worker** stack after the Worker
  exists. No tail consumer is attached. The token reaches the Alchemy child only as `CLOUDFLARE_API_TOKEN` in its
  env — never in the plan file — and is scrubbed from every log line like the box's own.

Two stacks per project:

- **`lunora-project-<alias>`** owns the per-project resources: a D1 database, KV namespace, R2 bucket
  (`forceDestroy`) or Queue per provisioned binding, named by `resourceName`; and for each producer
  queue whose `resource` matches a `queue_consumer` entry, a consumer attaching the Worker named by
  `LUNORA_CONTROL_PLANE_SCRIPT`. **Additive:** resources already in the stack's state are re-declared on
  every deploy, so a release that drops a binding never deletes data a rollback target still binds.
  They go only when the stack is destroyed.
- **`lunora-worker-<alias>`** owns the project's one Worker in the dispatch namespace, whose script
  name is the alias. Every deploy and every rollback converges this same Worker in place — a Durable
  Object namespace belongs to the script that defines its class, so a script per release would start
  each release on an empty `ShardDO`, and Workers for Platforms has no gradual deployments for user
  Workers. Releases are bundles the control plane stores in R2; a rollback is a `deploy` job carrying
  an older one. The Worker declares: the prebuilt bundle
  uploaded as-is (`main` + `bundle: false`), compatibility date/flags (defaults `2026-06-10` /
  `["nodejs_compat"]`), `tags`, `tailConsumers`, assets, and `env` — project resources by typed
  reference into the project stack's state (`Resource.ref(id, { stack, stage })`), `ai`/`browser`/
  `images`, Durable Objects (new classes are created SQLite-backed), Analytics Engine datasets (binding
  metadata only, so declared here), `vars` as `plain_text`, secrets as `Redacted` → `secret_text`.

`deploy` runs project then worker. `destroy` is only sent when the project is gone: it removes the
worker, then the project stack and its data.

Alchemy emits a `deleted_classes` migration for any Durable Object class a dispatch-namespace Worker
stops binding, so a release (or rollback target) that drops a class deletes that class's data. The
control plane refuses a manual rollback that would do this; a tenant deploy that drops a class is the
tenant's call, exactly as with a `deleted_classes` migration in wrangler.

Secrets travel to the Alchemy process in its env (`LUNORA_SECRETS`), never in the plan file, and every
log line is scrubbed of secret values and the API token before it leaves the box.

## Environment

| Variable                      | Required          | Use                                              |
| ----------------------------- | ----------------- | ------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`       | yes               | The cell's account.                              |
| `CLOUDFLARE_API_TOKEN`        | yes               | The cell's token. Needs the scopes listed below. |
| `LUNORA_CONTROL_PLANE_SCRIPT` | for routed queues | Worker attached as consumer on routed queues.    |
| `PORT`                        | no                | Default `8080`.                                  |

The Alchemy child gets an explicit allowlist of these plus `HOME` (the job's temp dir), `CI=true`,
`DO_NOT_TRACK=1`, `ALCHEMY_TELEMETRY_DISABLED=1`, `NO_COLOR=1` — nothing else from the box's env.

Token scopes: Workers Scripts edit (incl. Workers for Platforms), Workers KV, D1, R2, Queues edit;
Account Secrets Store edit and Workers subdomain read (the state store, below).

## State store

`Cloudflare.state()` — Alchemy's Cloudflare state store (`src/Cloudflare/StateStore/State.ts`): a Worker
named `alchemy-state-store` in the cell's own account, with its bearer token and encryption key in the
account's Secrets Store. It is the one store that works from a stateless container holding nothing but
the account id and token: the box reads the bearer token back through a short-lived edge-preview upload
and reaches the store at `alchemy-state-store.<account-subdomain>.workers.dev`. Local state is useless
here (the container is ephemeral); `HttpStateStore`/`PostgresState` would need a store run elsewhere.

An `account` job cannot use `Cloudflare.state()`: it runs with the CUSTOMER's credentials, so that store would be
found — or bootstrapped — in the customer's account, and convergence state is platform state a customer must
never be able to corrupt (`MULTIPLATFORM.md` §5.3). The program instead builds `makeHttpStateStore` over the cell's
own store (`plan.state === "platform"`), whose URL and bearer the job carries in `target.state` (the control plane's
`LUNORA_STATE_STORE_URL` / `LUNORA_STATE_STORE_TOKEN`) and the box hands the Alchemy child as env; `plan.mjs` refuses
an `account` job that names no store, or one off `workers.dev`. Stacks of different accounts never collide: the
stage names the account.

The first job in a fresh cell bootstraps it (the box passes `--yes`). Two first jobs racing on a new cell
could both try; bootstrap it once when the cell is created instead:

```bash
CI=true CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npx alchemy@2.0.0-beta.79 provider cloudflare bootstrap
```

The account needs a `workers.dev` subdomain.

## Egress

`allowedHosts` for the container:

| Host                                                  | Why                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `api.cloudflare.com`                                  | Every resource API, script and asset uploads.                  |
| `alchemy-state-store.<account-subdomain>.workers.dev` | The state store, and the edge-preview read of its token.       |
| `registry.npmjs.org` (optional)                       | The CLI's version check; bounded at 3s, harmless when blocked. |

Telemetry (`otel.alchemy.run`) is disabled by env and needs no egress.

## Not supported, and why

- **`workflow`** — Alchemy registers a Workflow with the account-level `putWorkflow`
  (`src/Cloudflare/Workflows/Workflow.ts`), which has no dispatch-namespace variant, and only for an
  Effect-native Workflow — not a prebuilt bundle's class. Refused on both targets.
- **An assets binding not named `ASSETS`** — Alchemy always binds uploaded assets as `ASSETS`. Refused.
- `container`, `hyperdrive`, `pipeline`, `vectorize` — refused here too, as in the deploy handler.

## Smoke test

The HTTP contract with Alchemy stubbed is `__tests__/provision-container.test.ts`; the mapping is
`__tests__/provision-plan.test.ts`. Against a real (throwaway) account:

```bash
docker build -t lunora-provision-box apps/cloud/containers/provision
docker run --rm -p 8080:8080 -e CLOUDFLARE_ACCOUNT_ID -e CLOUDFLARE_API_TOKEN \
  -e LUNORA_CONTROL_PLANE_SCRIPT=lunora-cloud-dev lunora-provision-box
curl -sN -X POST localhost:8080/__lunora/provision --data-binary @job.json
```
