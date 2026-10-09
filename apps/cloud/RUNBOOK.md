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
its bearer token: a cell that converges into customers' own accounts
(`cloudflare-workers`) needs both as Worker secrets (`LUNORA_STATE_STORE_URL`,
`LUNORA_STATE_STORE_TOKEN`, step 4), so that state stays here and never lands in
a customer's account.

The token lives in the account's Secrets Store, whose values the API never
returns. Bootstrap caches both values on the machine that ran it, in
`~/.alchemy/credentials/default/cloudflare-state-store.json`
(`{ "url", "authToken", "accountId" }`) — read them from there, set the two
secrets, then delete the file:

```bash
jq -r .url ~/.alchemy/credentials/default/cloudflare-state-store.json   # LUNORA_STATE_STORE_URL
jq -r .authToken ~/.alchemy/credentials/default/cloudflare-state-store.json | \
  npx wrangler secret put LUNORA_STATE_STORE_TOKEN --env staging
```

**Check:** `curl -H "Authorization: Bearer <token>" <url>/state/stacks` answers a
JSON array (`["CloudflareStateStore", …]`).

## 2. API tokens (Cloudflare dashboard — cannot be scripted from here)

Two tokens, both scoped to this account:

| Token                            | Where it goes                                                            | Permissions                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CI deploy token**              | GitHub Environment `cloud-staging` → secret `CLOUDFLARE_API_TOKEN`       | Workers Scripts:Edit, Workers KV:Edit, D1:Edit, R2:Edit, Queues:Edit, Workers for Platforms:Edit, Account Analytics:Read, Zone → Workers Routes:Edit (routed zone)                                                                                                                           |
| **Cell token** (provision + DNS) | Worker secret `CLOUDFLARE_API_TOKEN` on `lunora-cloud` (`--env staging`) | the provision box's set (Workers Scripts incl. WfP, D1, R2, KV, Queues, Secrets Store, Workers subdomain read) **plus Account Analytics:Read** (usage metering, below) **plus Zone → DNS:Edit on the box zone** (step 6) **and Zone → SSL and Certificates:Edit on the SaaS zone** (step 6a) |

Also set `CLOUDFLARE_ACCOUNT_ID` on the GitHub Environment.

The cell token's **Account Analytics:Read** is what the hourly usage readback
needs: the dispatcher's request counts (Analytics SQL API) and the D1 and
Durable Object row counts (GraphQL Analytics API) that the spend cap prices.
Without it, the sweep logs `[usage] cloudflare-wfp scope <cell>: storage
metering unavailable: …` (or `request metering …`) every hour, records it in
`usageSourceStatus`, and the Usage tab tells every organization that storage
is not counted toward its spend cap. D1 rows also need the D1 permission the
token already holds (to list databases), and Durable Object rows may need
Workers Scripts read (to list namespaces).

**Check:** `wrangler tail lunora-cloud --env staging` across the top of an
hour shows no `metering unavailable` line, and `SELECT * FROM
usageSourceStatus WHERE unavailableReason IS NOT NULL` on the control-plane D1
is empty.

Tokens an organization pastes for its own account (the `cloudflare-workers`
target, Cloudflare accounts tab) are not operator tokens and never go here.
Their permissions are `CLOUDFLARE_TOKEN_PERMISSIONS` in
`src/provision-contract.ts`: Workers Scripts:Edit (required); D1, Workers KV,
R2 and Queues:Edit as the app's bindings need them; Account Analytics:Read for
the usage chart; Billing:Read for the Cloudflare costs tab. The costs tab has
no token of its own any more — it reads a connected account that holds
Billing:Read.

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
  `LUNORA_STATE_STORE_TOKEN` (step 1; for `cloudflare-workers`), the four
  `BACKUP_OFFSITE_*` values for the off-site backup copy (a bucket and R2 token in
  a second account, [`docs/RESTORE.md`](./docs/RESTORE.md)), and the optional ones in
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

## 6a. Custom-domain certificates (Cloudflare for SaaS)

Custom domains on `cloudflare-wfp` get their certificates as Cloudflare-for-SaaS
custom hostnames on the zone tenants are served under (`LUNORA_APP_DOMAIN`,
e.g. `lunora.app` — customers CNAME their hostnames to it). Once per cell:

- Enable **SSL for SaaS** on that zone and set its **fallback origin** to a
  proxied hostname in it that the dispatcher Worker's route covers (e.g.
  `fallback.lunora.app`), so a custom hostname's traffic reaches the
  dispatcher, which routes it by hostname (`domains.routeForHostname`).
- Worker var or secret `LUNORA_SAAS_ZONE_ID` = that zone's id.
- Give the cell token **Zone → SSL and Certificates:Edit** on it (step 2): the
  control plane creates a custom hostname when a domain verifies, reads its
  certificate status hourly, and deletes it when the domain is removed.

Unset, verified domains record that no certificate could be requested
(`certificateStatus: "unconfigured"`) and a cell still deploys.

**Check:** verify a test domain in the studio's Domains tab; its row shows
"certificate pending", then "certificate active" within the hour, and
`https://<that hostname>` serves the project.

## 6b. Edge-block suspension (optional)

A suspended organization (spend cap, dunning, overage, support) is refused by
the dispatcher with a 503, but that 503 is itself a billed Workers-for-Platforms
request. The hourly edge-block sweep moves the stop in front of the Worker
(`src/targets/cloudflare-wfp/edge-block.ts`). A cell runs in one of three
modes (`src/domains/edge-block-mode.ts`), and the Domains tab says which:

- **`dispatcher` (the default): nothing to set up.** With neither setting
  below, the edge block does nothing and the dispatcher's 503 is the block.
  Nothing about a customer's domains changes. Every request to a suspended
  tenant is still billed.
- **`delete-hostnames`: opt in with `LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES=1`**
  (needs the SaaS zone, step 6a). A suspended org's custom hostnames are
  deleted and recreated when it recovers. Cloudflare has no API to deactivate
  a custom hostname, so deletion is the only edge stop without a WAF list.
  **The trade-off:** this turns a billing suspension into a destructive change
  to the customer's domains. Recovery re-issues every certificate (HTTP DV, a
  few minutes while the CNAME is in place). If the customer moved their CNAME
  while suspended, or the re-create fails, the domain stays broken until the
  restore succeeds (retried hourly, shown on the domain). Turn it on only where
  the requests a 503 costs outweigh that risk. Platform hostnames
  (`{alias}.lunora.app`) keep the 503. Turning the setting off later stops new
  deletions; domains it already blocked are still restored on recovery.
- **`list`: the Enterprise suspended-hostnames list.** This covers platform
  hostnames too, and certificates stay as they are. Once per cell:
    1. Account → Manage Account → Configurations → Lists: create a list of type
       **Hostname**, e.g. `lunora_suspended`. Nothing else may write to it: the
       sweep removes every item it did not put there.
    2. On the zone of `LUNORA_APP_DOMAIN`, add a WAF custom rule
       `http.host in $lunora_suspended` → **Block**, with a custom JSON response
       (status 503, e.g. `{"error":"this deployment is suspended — see your billing page"}`).
    3. Worker var `LUNORA_SUSPENDED_HOSTS_LIST_ID` = the list's id, and give the
       cell token **Account → Account Filter Lists:Edit**.

Every block and restore writes an audit entry on the organization
(`domain.edge_block` / `domain.edge_unblock`, or `organization.edge_block` /
`organization.edge_unblock` for the list). A failed step never changes the
suspension. It is retried every hour and logged as `[edge-block]` in Workers
Logs. A failed custom-hostname step is also recorded on the domain row
(`edgeBlockError`), which the Domains tab shows.

The list takes precedence when both are set, and needs no deletion.

**Check:** the Domains tab's note names the mode. In `list` or
`delete-hostnames` mode, suspend a test org with a verified custom domain
(support: `suspendedAt` set). Within the hour `https://<that domain>` fails at
the edge. In `delete-hostnames` mode the domain also reads "blocked:
suspended". Lift the suspension and, within the hour, the domain serves again
(in `delete-hostnames` mode, with a fresh certificate).

## 7. `hostd` release signing key

Exact steps in [`../hostd/README.md`](../hostd/README.md) § Releases & signing:

1. `openssl genpkey -algorithm ed25519 -out hostd-release.pem` on a trusted
   machine.
2. `cargo run --release --bin hostd-release -- public-key hostd-release.pem` (in
   `apps/hostd`) prints the public key entry; commit it to
   `HOSTD_TRUSTED_RELEASE_KEYS` and delete the placeholder (a pull request —
   the control plane refuses every release until this lands).
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
