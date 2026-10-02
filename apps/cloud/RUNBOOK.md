# Lunora Cloud — ops runbook: from merged code to a live cell

The code for the control plane, push-to-deploy and customer boxes (plan 458,
G2–G18) is in the repo. Nothing runs until the steps below are done, and none
of them can be done from a pull request: they create resources in a Cloudflare
account, secrets in GitHub, and a signing key that only a maintainer may hold.

Do them in order, once per cell. "Staging" names are shown; for production,
drop the `-staging` suffix and use `--env production`. Each step says how to
check it worked. The detail behind each step lives in [`README.md`](./README.md)
§ Deploy; this file is the order to do them in.

## 0. Prerequisites

- A Cloudflare account with **Workers Paid**, **Workers for Platforms** and
  **Containers** enabled, and the zone the dispatcher routes (`lunora.app` in
  `dispatcher.wrangler.jsonc`) on that account.
- `wrangler` logged in to that account (`npx wrangler whoami`).
- Admin on `anolilab/lunora` (to create GitHub Environments and an App).
- Docker with `buildx` on the machine that runs the first deploy: `wrangler
deploy` builds both container images (build box, provision box) locally.

## 1. Cloudflare resources

```bash
cd apps/cloud
npx wrangler d1 create lunora-cloud-staging
npx wrangler r2 bucket create lunora-cloud-telemetry-staging
npx wrangler r2 bucket create lunora-cloud-releases-staging
npx wrangler r2 bucket create lunora-cloud-tenant-backups-staging
npx wrangler pipelines create lunora-cloud-telemetry-staging
npx wrangler dispatch-namespace create lunora-staging
```

Paste the D1 id, the account id and the control-plane URL over the
`<replace-with-…>` placeholders in `wrangler.jsonc`, `dispatcher.wrangler.jsonc`
and `tail.wrangler.jsonc` (staging blocks only).

**Check:** `pnpm --filter @lunora/cloud run deploy:check staging` lists no
placeholder for the cell.

Bootstrap the Alchemy state store once, so two first deploys cannot race to
create it ([`containers/provision/README.md`](./containers/provision/README.md)):

```bash
CI=true CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
  npx alchemy@2.0.0-beta.79 provider cloudflare bootstrap
```

Keep the store's URL (`https://alchemy-state-store.<subdomain>.workers.dev`) and
its bearer token (in the account's Secrets Store): a cell that converges into
customers' own accounts (`cloudflare-workers`) needs both as Worker secrets
(`LUNORA_STATE_STORE_URL`, `LUNORA_STATE_STORE_TOKEN`, step 4), so that state
stays here and never lands in a customer's account.

## 2. API tokens (Cloudflare dashboard — cannot be scripted from here)

Two tokens, both scoped to this account:

| Token                            | Where it goes                                                            | Permissions                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CI deploy token**              | GitHub Environment `cloud-staging` → secret `CLOUDFLARE_API_TOKEN`       | Workers Scripts:Edit, Workers KV:Edit, D1:Edit, R2:Edit, Queues:Edit, Workers for Platforms:Edit, Account Analytics:Read, Zone → Workers Routes:Edit (routed zone) |
| **Cell token** (provision + DNS) | Worker secret `CLOUDFLARE_API_TOKEN` on `lunora-cloud` (`--env staging`) | the provision box's set (Workers Scripts incl. WfP, D1, R2, KV, Queues, Secrets Store, Workers subdomain read) **plus Zone → DNS:Edit on the box zone** (step 6)   |

Also set `CLOUDFLARE_ACCOUNT_ID` on the GitHub Environment.

**Check:** `curl -H "Authorization: Bearer <token>" https://api.cloudflare.com/client/v4/user/tokens/verify`
answers `"status": "active"` for each.

## 3. GitHub App (browser — cannot be scripted from here)

Register an App on the `anolilab` org (Settings → Developer settings → GitHub
Apps → New):

- **Webhook URL:** `https://<staging control-plane origin>/v1/github/webhook`;
  **secret:** a random value, also stored as Worker secret
  `GITHUB_WEBHOOK_SECRET`.
- **Repository permissions:** Contents: Read (source tarballs and push diffs),
  Commit statuses: Read & write (build / release status), Metadata: Read.
- **Subscribe to events:** Push, Pull request.
- Generate a private key. Store the App id as `GITHUB_APP_ID` and the PEM as
  `GITHUB_APP_PRIVATE_KEY` (Worker secrets, `--env staging`).

Fork pull requests are built but never deployed (plan 458 Thermos fix), so the
App can be installed on public repositories.

**Check:** install the App on a test repo, push to its default branch, and see a
`builds` row plus a commit status within a minute.

## 4. Worker secrets

`wrangler secret put <NAME> --env staging` for each, on the Worker named:

- `lunora-cloud`: `LUNORA_ADMIN_TOKEN`, `AUTH_SECRET`, `SECRET_ENCRYPTION_KEY`
  (64 hex), `CLOUDFLARE_API_TOKEN` (the cell token), `GITHUB_WEBHOOK_SECRET`,
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `CREEM_API_KEY`,
  `CREEM_WEBHOOK_SECRET`, `LUNORA_TAIL_SECRET`, `LUNORA_STATE_STORE_URL` +
  `LUNORA_STATE_STORE_TOKEN` (step 1; for `cloudflare-workers`), and the optional ones in
  [`.dev.vars.example`](./.dev.vars.example) (each documents its symptom when
  unset).
- `lunora-dispatcher`: `CONTROL_PLANE_TOKEN` = the control plane's
  `LUNORA_ADMIN_TOKEN`.
- `lunora-log-tail`: `LUNORA_TAIL_SECRET` = the same value as the control plane.

## 5. First deploy and smoke

Run the `deploy-cloud` workflow (`workflow_dispatch`, target `staging`), or push
to `alpha`. Set `CLOUD_HEALTH_URL` as a variable on the `cloud-staging`
environment so every deploy is probed.

**Check:**

1. Sign in with the seeded invitation (registration is invite-only — README §
   Auth).
2. `POST /v1/cells` with the admin token registers the cell; create an org and a
   project.
3. `lunora cloud deploy` from a sample app goes `live`, then a push through the
   GitHub App does the same with no CLI involved.

## 6. Box zone (customer servers)

Pick a zone on the account for box hostnames, e.g. `boxes.lunora.app` as a
subdomain of `lunora.app`. Then:

- Worker var `LUNORA_BOX_DOMAIN` = that name (defaults to `boxes.lunora.app`).
- Worker secret or var `LUNORA_BOX_ZONE_ID` = the zone's id.
- Confirm the cell token has Zone → DNS:Edit on it (step 2).

It is deliberately **not** a `<replace-with-…>` placeholder: without it, boxes
still enrol, with `dnsError` set and no hostnames, so a cell without boxes is not
blocked from deploying.

**Check:** after a box enrols, `<slug>.<domain>` and `*.<slug>.<domain>` resolve
to its address; the hourly box sweep logs no orphan deletions.

## 7. `hostd` release signing key

Exact steps in [`../hostd/README.md`](../hostd/README.md) § Releases & signing:

1. `openssl genpkey -algorithm ed25519 -out hostd-release.pem` on a trusted
   machine.
2. `node apps/hostd/scripts/release-public-key.mjs hostd-release.pem` prints the
   public key entry; commit it to `HOSTD_TRUSTED_RELEASE_KEYS` and delete the
   placeholder (a pull request — the control plane refuses every release until
   this lands).
3. Create GitHub Environment `hostd-release` **with a required reviewer**; store
   the whole PEM as secret `HOSTD_RELEASE_SIGNING_KEY`.
4. Keep an offline backup; delete the local copy.

**Check:** run `hostd-release.yml` (`workflow_dispatch`); it builds, signs and
publishes `hostd-v<version>`. Then `POST /v1/hostd/releases` (admin token) with
the release's `manifest.json` is accepted.

## 8. Not covered here

- The `lunora-hostd` daemon that runs on a customer box (plan 458 W4/W8) is
  built on its own branch; until it ships, no box can enrol, whatever is set up
  above.
- Production: repeat 1–7 with production names and the `cloud-production`
  environment (give it a required reviewer).
